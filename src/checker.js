import fs from 'fs';
import path from 'path';
import { spawn, exec } from 'child_process';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ensureXray } from './xray-downloader.js';
import os from 'os';
import util from 'util';

const execPromise = util.promisify(exec);

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

function generateConfig(vlessObj, localPort, useMux = false) {
    const outbound = {
        protocol: "vless",
        ...(useMux ? { mux: { enabled: true, concurrency: 8 } } : {}),
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
    const limit = process.env.TEST_LIMIT ? parseInt(process.env.TEST_LIMIT) : links.length;
    const linksToTest = links.slice(0, limit);

    const isAndroid = os.arch() === 'arm64' || os.arch() === 'aarch64' || os.platform() === 'android';
    const CONCURRENCY = isAndroid ? 20 : 50;
    
    // ============================================
    // PHASE 1: HIGH CONCURRENCY PING TEST
    // ============================================
    console.log(`\n[Phase 1] Ping Testing ${linksToTest.length} links (Concurrency: ${CONCURRENCY})...`);
    const workingLinks = [];
    let completedPhase1 = 0;

    async function pingSingleLink(link, i) {
        try {
            const parsed = parseVlessUrl(link);
            const localPort = 10000 + Math.floor(Math.random() * 30000);
            const config = generateConfig(parsed, localPort);
            
            const configPath = path.join(os.tmpdir(), `xray-${localPort}-${i}.json`);
            fs.writeFileSync(configPath, JSON.stringify(config));
            
            const xrayProc = spawn(xrayExe, ['run', '-c', configPath]);
            await new Promise(r => setTimeout(r, 1500));
            
            const agent = new HttpsProxyAgent(`http://127.0.0.1:${localPort}`);
            const startTime = Date.now();
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            
            try {
                const res = await axios.get('https://cp.cloudflare.com/generate_204', {
                    httpsAgent: agent,
                    timeout: 5000,
                    signal: controller.signal,
                    validateStatus: () => true
                });
                clearTimeout(timeoutId);
                
                if (res.status === 204) {
                    const latency = Date.now() - startTime;
                    const remarkText = parsed.remark || 'Unknown Server';
                    workingLinks.push({ link, latency, remark: remarkText, parsed });
                }
            } catch (err) {
                clearTimeout(timeoutId);
                // Silently ignore ping failures
            }
            
            xrayProc.kill('SIGTERM');
            try { fs.unlinkSync(configPath); } catch (e) {}
            
        } catch (err) {
            // Silently ignore parsing errors
        } finally {
            completedPhase1++;
            if (completedPhase1 % 25 === 0 || completedPhase1 === linksToTest.length) {
                console.log(`Phase 1 Progress: ${completedPhase1}/${linksToTest.length} tested. Found ${workingLinks.length} responsive servers so far...`);
            }
        }
    }

    let index = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (index < linksToTest.length) {
            const currentIndex = index++;
            await pingSingleLink(linksToTest[currentIndex], currentIndex);
        }
    });

    await Promise.all(workers);

    if (workingLinks.length === 0) {
        console.log(`\nTesting complete. Found 0 working servers.`);
        return [];
    }

    // ============================================
    // PHASE 2: SEQUENTIAL SPEED TEST
    // ============================================
    console.log(`\n[Phase 2] Speed Testing ${workingLinks.length} working servers sequentially...`);
    console.log(`Downloading 5MB payload per server. Timeout is 10 seconds. Please wait...\n`);
    
    const finalLinks = [];
    let completedPhase2 = 0;

    for (const item of workingLinks) {
        completedPhase2++;
        let speedMbps = 0;
        
        async function runSpeedTest(useMux) {
            let resultMbps = 0;
            const localPort = 10000 + Math.floor(Math.random() * 30000);
            const config = generateConfig(item.parsed, localPort, useMux);
            const configPath = path.join(os.tmpdir(), `xray-${localPort}-speed-${useMux?'mux':'nomux'}.json`);
            fs.writeFileSync(configPath, JSON.stringify(config));
            
            const xrayProc = spawn(xrayExe, ['run', '-c', configPath]);
            await new Promise(r => setTimeout(r, 1500));
            
            try {
                const isWin = process.platform === 'win32';
                const devNull = isWin ? 'NUL' : '/dev/null';
                const curlCmd = isWin ? 'curl.exe' : 'curl';
                
                const cmd = `${curlCmd} -x http://127.0.0.1:${localPort} -s -o ${devNull} -w "%{speed_download}" --max-time 10 https://speed.cloudflare.com/__down?bytes=5242880`;
                
                let rawOutput = '0';
                try {
                    const { stdout } = await execPromise(cmd);
                    rawOutput = stdout;
                } catch (execErr) {
                    if (execErr.stdout) rawOutput = execErr.stdout;
                }
                
                const bytesPerSec = parseFloat(rawOutput.trim()) || 0;
                if (bytesPerSec > 0) {
                    resultMbps = (bytesPerSec * 8) / 1000000;
                }
            } catch (err) {}
            
            xrayProc.kill('SIGTERM');
            try { fs.unlinkSync(configPath); } catch (e) {}
            return resultMbps;
        }

        try {
            speedMbps = await runSpeedTest(true); // Try with MUX first
            if (speedMbps < 0.1) {
                // If Mux failed (server rejected it), retry without Mux
                speedMbps = await runSpeedTest(false);
                if (speedMbps > 0) {
                    console.log(`\x1b[33m[${completedPhase2}/${workingLinks.length}]\x1b[0m ${item.remark.padEnd(25)} | Ping: ${item.latency.toString().padEnd(5)}ms | Speed: \x1b[33m${speedMbps.toFixed(2).padStart(5)} Mbps (No Mux)\x1b[0m`);
                } else {
                    console.log(`\x1b[31m[${completedPhase2}/${workingLinks.length}]\x1b[0m ${item.remark.padEnd(25)} | Ping: ${item.latency.toString().padEnd(5)}ms | Speed: \x1b[31mFAILED\x1b[0m`);
                }
            } else {
                console.log(`\x1b[32m[${completedPhase2}/${workingLinks.length}]\x1b[0m ${item.remark.padEnd(25)} | Ping: ${item.latency.toString().padEnd(5)}ms | Speed: \x1b[36m${speedMbps.toFixed(2).padStart(5)} Mbps (Mux)\x1b[0m`);
            }
        } catch (err) {
            console.log(`[Phase 2 Error] ${err.message}`);
        }
        
        finalLinks.push({ ...item, speedMbps });
    }

    // Filter out any servers slower than 3 Mbps
    const filteredLinks = finalLinks.filter(w => w.speedMbps >= 3);

    // Sort using a composite score to prioritize highest speed AND lowest ping simultaneously!
    // Formula: (Speed * 1000) / Ping. Higher score is better.
    filteredLinks.sort((a, b) => {
        const scoreA = (a.speedMbps * 1000) / (a.latency || 1);
        const scoreB = (b.speedMbps * 1000) / (b.latency || 1);
        return scoreB - scoreA;
    });

    console.log(`\nTesting complete! Filtered down to ${filteredLinks.length} premium servers >= 3 Mbps.`);
    
    let liberaCounter = 1;

    // We update the remark to only show the country and the speed metric!
    
    // 1. Gather all hostnames for a single batch Geolocation request
    const hostsToGeolocate = filteredLinks.map(w => new URL(w.link).hostname);
    const uniqueHosts = [...new Set(hostsToGeolocate)];
    
    let geoCache = {};
    try {
        console.log(`\nGeolocating ${uniqueHosts.length} servers via ip-api.com...`);
        // The free batch API accepts up to 100 IPs/domains per POST request
        const res = await fetch('http://ip-api.com/batch?fields=query,countryCode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(uniqueHosts.slice(0, 100))
        });
        
        if (res.ok) {
            const geoData = await res.json();
            geoData.forEach(item => {
                if (item.countryCode) {
                    geoCache[item.query] = item.countryCode;
                }
            });
        }
    } catch (err) {
        console.log("Geolocation failed. Falling back to default flags.");
    }

    
    const finalExportLinks = filteredLinks.map(w => {
        const url = new URL(w.link);
        let originalRemark = decodeURIComponent(url.hash.slice(1));
        
        // Check if it came from the goida repo
        let isGoida = false;
        if (originalRemark.endsWith('-GOIDA')) {
            isGoida = true;
            originalRemark = originalRemark.slice(0, -6); // Strip the marker
        }
        
        // Get the dynamically generated flag emoji from the GeoIP lookup
        let flag = '🌐 ';
        const cc = geoCache[url.hostname];
        if (cc) {
            // Convert 'US' to '🇺🇸' using Regional Indicator Symbol code points
            flag = String.fromCodePoint(...cc.toUpperCase().split('').map(c => 127397 + c.charCodeAt(0))) + ' ';
        }

        // Extract existing country string, or override if Goida
        let country = originalRemark.split(/[,|\[]/)[0].trim();
        if (isGoida) {
            country = `${flag}Libera ${liberaCounter++}`;
        } else {
            // Some old names have flags embedded. We could just use our new dynamic flag instead!
            // To keep it simple, we'll prepend our dynamic flag and let the string look like "🇩🇪 Germany"
            const flagMatch = originalRemark.match(/^\s*([^\x00-\x7F]+)/);
            const existingFlag = flagMatch ? flagMatch[1].trim() + ' ' : '';
            // If it already had a flag, use the old string. If not, use our dynamic one!
            country = existingFlag ? country : `${flag}${country}`;
        }
        
        let speedMetric = "Slow";
        if (w.speedMbps > 20) {
            speedMetric = "Fast 🚀";
        } else if (w.speedMbps >= 5) {
            speedMetric = "Normal ⚡";
        }
        
        const newRemark = `${country} - ${speedMetric}`;
        url.hash = `#${encodeURIComponent(newRemark)}`;
        return url.toString();
    });

    return finalExportLinks;
}
