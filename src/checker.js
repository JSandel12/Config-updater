import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ensureXray } from './xray-downloader.js';
import os from 'os';

function parseVlessUrl(link) {
    const url = new URL(link);
    const params = Object.fromEntries(url.searchParams.entries());
    return {
        protocol: "vless",
        uuid: url.username,
        address: url.hostname,
        port: url.port,
        params: params,
        remark: decodeURIComponent(url.hash.slice(1))
    };
}

function generateConfig(vlessObj, localPort) {
    const outbound = {
        protocol: "vless",
        settings: {
            vnext: [{
                address: vlessObj.address,
                port: parseInt(vlessObj.port),
                users: [{
                    id: vlessObj.uuid,
                    encryption: vlessObj.params.encryption || "none",
                    flow: vlessObj.params.flow || ""
                }]
            }]
        },
        streamSettings: {
            network: vlessObj.params.type || "tcp",
            security: vlessObj.params.security || "none"
        }
    };

    if (vlessObj.params.security === 'tls' || vlessObj.params.security === 'reality') {
        const settings = {
            serverName: vlessObj.params.sni || "",
            fingerprint: vlessObj.params.fp || "",
            alpn: vlessObj.params.alpn ? vlessObj.params.alpn.split(',') : undefined
        };
        if (vlessObj.params.security === 'reality') {
            settings.publicKey = vlessObj.params.pbk || "";
            settings.shortId = vlessObj.params.sid || "";
            settings.spiderX = vlessObj.params.spx || "";
            outbound.streamSettings.realitySettings = settings;
        } else {
            outbound.streamSettings.tlsSettings = settings;
        }
    }

    if (outbound.streamSettings.network === 'ws') {
        outbound.streamSettings.wsSettings = {
            path: vlessObj.params.path || "/",
            headers: { Host: vlessObj.params.host || vlessObj.params.sni || "" }
        };
    } else if (outbound.streamSettings.network === 'grpc') {
        outbound.streamSettings.grpcSettings = {
            serviceName: vlessObj.params.serviceName || vlessObj.params.path || "",
            multiMode: vlessObj.params.mode === 'multi'
        };
    }

    return {
        log: { loglevel: "none" },
        inbounds: [{
            port: localPort,
            listen: "127.0.0.1",
            protocol: "http",
            settings: { timeout: 0 }
        }],
        outbounds: [outbound]
    };
}

export async function checkLinks(links) {
    const xrayExe = await ensureXray();
    const workingLinks = [];
    
    const limit = process.env.TEST_LIMIT ? parseInt(process.env.TEST_LIMIT) : links.length;
    const linksToTest = links.slice(0, limit);

    const isAndroid = os.arch() === 'arm64' || os.arch() === 'aarch64' || os.platform() === 'android';
    const CONCURRENCY = isAndroid ? 20 : 50;
    console.log(`Testing ${linksToTest.length} links concurrently (up to ${CONCURRENCY} at a time)...`);
    
    let completed = 0;

    async function testSingleLink(link, i) {
        try {
            const parsed = parseVlessUrl(link);
            const localPort = 10000 + Math.floor(Math.random() * 30000); // Random port to prevent conflicts
            const config = generateConfig(parsed, localPort);
            
            const configPath = path.join(os.tmpdir(), `xray-${localPort}-${i}.json`);
            fs.writeFileSync(configPath, JSON.stringify(config));
            
            let xrayErrorLogged = false;
            const xrayProc = spawn(xrayExe, ['run', '-c', configPath]);
            
            xrayProc.on('error', (err) => { 
                if (i === 0) console.log(`[DEBUG] Xray spawn error:`, err.message); 
            });
            xrayProc.stderr.on('data', (data) => {
                if (i === 0 && !xrayErrorLogged) {
                    console.log(`[DEBUG] Xray stderr:`, data.toString());
                    xrayErrorLogged = true;
                }
            });
            xrayProc.on('exit', (code) => { 
                if (code !== null && code !== 0 && i === 0) {
                    console.log(`[DEBUG] Xray exited prematurely with code:`, code); 
                }
            });
            
            // Wait for xray to bind the local port
            await new Promise(r => setTimeout(r, 1500));
            
            const agent = new HttpsProxyAgent(`http://127.0.0.1:${localPort}`);
            const startTime = Date.now();
            
            try {
                const res = await axios.get('https://cp.cloudflare.com/generate_204', {
                    httpsAgent: agent,
                    timeout: 5000,
                    validateStatus: () => true
                });
                if (res.status === 204) {
                    const latency = Date.now() - startTime;
                    if (latency <= 1000) {
                        const remarkText = parsed.remark || 'Unknown Server';
                        console.log(`\x1b[32m[${i + 1}/${linksToTest.length}] OK\x1b[0m (${latency}ms) - ${remarkText}`);
                        workingLinks.push({ link, latency, remark: remarkText });
                    }
                } else if (i === 0) {
                    console.log(`[DEBUG] Axios returned status: ${res.status}`);
                }
            } catch (err) {
                if (i === 0) {
                    console.log(`[DEBUG] Axios connection error: ${err.message}`);
                }
            }
            
            xrayProc.kill('SIGTERM');
            try { fs.unlinkSync(configPath); } catch (e) {}
            
        } catch (err) {
            // Silently ignore parsing errors
        } finally {
            completed++;
            if (completed % 25 === 0 || completed === linksToTest.length) {
                console.log(`Progress: ${completed}/${linksToTest.length} tested. Found ${workingLinks.length} working servers so far...`);
            }
        }
    }

    // Worker pool logic
    let index = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (index < linksToTest.length) {
            const currentIndex = index++;
            await testSingleLink(linksToTest[currentIndex], currentIndex);
        }
    });

    await Promise.all(workers);
    
    console.log(`\nTesting complete! Found ${workingLinks.length} working servers out of ${linksToTest.length}.`);
    
    // Sort by Country/Remark alphabetically first, so countries are grouped together.
    // If the country is the same, sort the fastest ones to the top.
    workingLinks.sort((a, b) => {
        const nameA = a.remark.toUpperCase();
        const nameB = b.remark.toUpperCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        return a.latency - b.latency;
    });
    return workingLinks.map(w => w.link);
}
