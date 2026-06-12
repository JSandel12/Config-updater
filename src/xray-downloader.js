import fs from 'fs';
import path from 'path';
import https from 'https';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';

import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const xrayDir = path.join(__dirname, '..', 'xray');
const isWindows = os.platform() === 'win32';
const xrayExe = path.join(xrayDir, isWindows ? 'xray.exe' : 'xray');

export async function ensureXray() {
    if (fs.existsSync(xrayExe)) {
        return xrayExe;
    }

    console.log('Xray not found. Downloading...');
    if (!fs.existsSync(xrayDir)) {
        fs.mkdirSync(xrayDir, { recursive: true });
    }

    const zipPath = path.join(xrayDir, 'xray.zip');
    
    // Download Xray-core
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(zipPath);
        function fetchUrl(url) {
            https.get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    fetchUrl(response.headers.location);
                } else {
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close(resolve);
                    });
                }
            }).on('error', reject);
        }
        let downloadUrl = 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip';
        if (isWindows) {
            downloadUrl = 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip';
        } else if (os.arch() === 'arm64' || os.arch() === 'aarch64') {
            downloadUrl = 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-android-arm64-v8a.zip';
        } else if (os.arch() === 'arm') {
            downloadUrl = 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-android-arm32-v7a.zip';
        }
            
        console.log(`[DEBUG] os.platform(): ${os.platform()}, os.arch(): ${os.arch()}`);
        console.log(`[DEBUG] Selected Xray URL: ${downloadUrl}`);
        fetchUrl(downloadUrl);
    });

    console.log(`Extracting Xray for ${isWindows ? 'Windows' : 'Linux'}...`);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(xrayDir, true);
    fs.unlinkSync(zipPath);
    
    // On Linux, we need to make the binary executable
    if (!isWindows) {
        fs.chmodSync(xrayExe, '755');
    }
    
    console.log('Xray downloaded successfully.');
    return xrayExe;
}
