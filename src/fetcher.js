import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';

export async function fetchConfigs() {
    console.log('Fetching configs from repositories via git clone...');
    try {
        let allText = '';
        const repos = [
            { url: 'https://github.com/flaafix/AetrisVPN-white-list-lite.git', dir: 'AetrisVPN-white-list-lite' },
            { url: 'https://github.com/igareck/vpn-configs-for-russia.git', dir: 'vpn-configs-for-russia' },
            { url: 'https://github.com/AvenCores/goida-vpn-configs.git', dir: 'goida-vpn-configs' }
        ];

        for (const repo of repos) {
            const tempDir = path.join(os.tmpdir(), repo.dir);
            
            if (fs.existsSync(tempDir)) {
                try {
                    execSync('git pull', { cwd: tempDir, stdio: 'ignore' });
                } catch (err) {
                    console.log(`[Warning] Blocked from updating ${repo.dir}. Using offline cache...`);
                }
            } else {
                try {
                    execSync(`git clone --depth 1 ${repo.url} ${tempDir}`, { stdio: 'ignore' });
                } catch (err) {
                    console.log(`[Error] Failed to clone ${repo.dir}. Please connect to WiFi for the first run!`);
                }
            }
            
            const files = getAllFiles(tempDir);
            
            // Prioritize specific files for igareck repo
            if (repo.dir === 'vpn-configs-for-russia') {
                const priorityFiles = ['WHITE-CIDR-RU-all.txt', 'WHITE-SNI-RU-all.txt'];
                for (const pFile of priorityFiles) {
                    const fullPath = path.join(tempDir, pFile);
                    if (fs.existsSync(fullPath)) {
                        allText += fs.readFileSync(fullPath, 'utf-8') + '\n';
                    }
                }
            }
            
            for (const file of files) {
                if (repo.dir === 'vpn-configs-for-russia') {
                    const filename = path.basename(file);
                    // Skip the priority files because we already appended them at the very top
                    if (filename === 'WHITE-CIDR-RU-all.txt' || filename === 'WHITE-SNI-RU-all.txt') {
                        continue;
                    }
                }

                if (repo.dir === 'goida-vpn-configs') {
                    // Only read 1.txt through 7.txt in the githubmirror folder
                    if (file.includes('githubmirror')) {
                        const filename = path.basename(file);
                        const match = filename.match(/^(\d+)\.txt$/);
                        if (match) {
                            const num = parseInt(match[1], 10);
                            if (num >= 1 && num <= 7) {
                                let fileText = fs.readFileSync(file, 'utf-8');
                                // Append -GOIDA to the remark so we can identify it in checker.js
                                fileText = fileText.replace(/(vless:\/\/[^\s"'<]+[^\s"'<.,])/g, (match) => {
                                    return match.includes('#') ? match + '-GOIDA' : match + '#-GOIDA';
                                });
                                allText += fileText + '\n';
                            }
                        }
                    }
                    continue;
                }

                if (file.endsWith('.txt') || file.endsWith('.md')) {
                    allText += fs.readFileSync(file, 'utf-8') + '\n';
                }
            }
        }
        
        // Extract vless links using regex
        const regex = /vless:\/\/[^\s"'<]+[^\s"'<.,]/g;
        let matches = allText.match(regex) || [];
        
        // Strip "AetrisVPN" from the links and replace with "LTE"
        matches = matches.map(link => link.replace(/AetrisVPN/g, 'LTE'));
        
        const uniqueLinks = [...new Set(matches)];
        
        // Deep Deduplication: Remove links that point to the exact same IP/Domain and Port
        const uniqueServers = new Map();
        for (const link of uniqueLinks) {
            try {
                const url = new URL(link);
                const key = `${url.hostname}:${url.port}`;
                // Only keep the first one we see for each IP:Port
                if (!uniqueServers.has(key)) {
                    uniqueServers.set(key, link);
                }
            } catch (e) {
                // Ignore malformed URLs
            }
        }
        
        const deepDeduplicatedLinks = Array.from(uniqueServers.values());
        
        console.log(`Found ${deepDeduplicatedLinks.length} unique vless servers (deduplicated by IP:Port).`);
        return deepDeduplicatedLinks;
    } catch (error) {
        console.error('Failed to fetch configs:', error.message);
        return [];
    }
}

function getAllFiles(dirPath, arrayOfFiles) {
    const files = fs.readdirSync(dirPath);
    arrayOfFiles = arrayOfFiles || [];
    
    files.forEach(function(file) {
        if (fs.statSync(dirPath + "/" + file).isDirectory()) {
            // Ignore .git
            if (file !== '.git') {
                arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
            }
        } else {
            arrayOfFiles.push(path.join(dirPath, "/", file));
        }
    });
    
    return arrayOfFiles;
}
