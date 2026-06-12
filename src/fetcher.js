import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';

export async function fetchConfigs() {
    console.log('Fetching configs from igareck/vpn-configs-for-russia via git clone...');
    try {
        const tempDir = path.join(os.tmpdir(), 'vpn-configs-for-russia');
        
        if (fs.existsSync(tempDir)) {
            execSync('git pull', { cwd: tempDir, stdio: 'ignore' });
        } else {
            execSync('git clone --depth 1 https://github.com/igareck/vpn-configs-for-russia.git ' + tempDir, { stdio: 'ignore' });
        }
        
        const files = getAllFiles(tempDir);
        let allText = '';
        
        for (const file of files) {
            if (file.endsWith('.txt')) {
                allText += fs.readFileSync(file, 'utf-8') + '\n';
            }
        }
        
        // Extract vless links using regex
        const regex = /vless:\/\/[^\s"'<]+[^\s"'<.,]/g;
        const matches = allText.match(regex) || [];
        
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
