import fs from 'fs';
import path from 'path';
import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function restore() {
    const backupPath = path.join(__dirname, '..', 'backup_links.json');
    if (!fs.existsSync(backupPath)) {
        console.error('Error: backup_links.json not found in the root directory.');
        process.exit(1);
    }

    let backupData;
    try {
        const raw = fs.readFileSync(backupPath, 'utf-8');
        backupData = JSON.parse(raw);
    } catch (e) {
        console.error('Error: Failed to parse backup_links.json. Make sure it is valid JSON.');
        process.exit(1);
    }

    if (!Array.isArray(backupData) || backupData.length === 0) {
        console.error('Error: Backup file is empty or invalid format.');
        process.exit(1);
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('Error: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file.');
        process.exit(1);
    }

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const headers = {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
    };
    const httpsAgent = new https.Agent({ family: 4 });

    console.log(`Preparing to restore ${backupData.length} links to Supabase...`);

    try {
        console.log(`[DEBUG] Attempting to clear existing links from Supabase (${url})...`);
        const deleteRes = await axios.delete(`${url}/rest/v1/working_links?id=gt.0`, { headers, timeout: 15000, httpsAgent });
        console.log(`[DEBUG] Database cleared successfully. Status: ${deleteRes.status}`);

        // Strip the ID column if it exists so Supabase can generate new IDs or accept them
        const rowsToInsert = backupData.map(row => {
            return {
                link: row.link,
                latency: row.latency,
                remark: row.remark
            };
        });

        console.log(`[DEBUG] Inserting backup links...`);
        const chunkSize = 5;
        for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
            const chunk = rowsToInsert.slice(i, i + chunkSize);
            console.log(`[DEBUG] Inserting chunk ${Math.floor(i/chunkSize) + 1}/${Math.ceil(rowsToInsert.length/chunkSize)}...`);
            const postRes = await axios.post(`${url}/rest/v1/working_links`, chunk, { headers, timeout: 15000, httpsAgent });
            if (postRes.status !== 201 && postRes.status !== 200) {
                 throw new Error(`Unexpected status ${postRes.status} on chunk insert`);
            }
        }

        console.log(`\n✅ Restore complete! Successfully rolled back the database to the previous ${backupData.length} links.`);
        
        // Also update sub.txt locally for parity
        const rawLinks = rowsToInsert.map(obj => obj.link).join('\n');
        const base64Sub = Buffer.from(rawLinks).toString('base64');
        fs.writeFileSync(path.join(__dirname, '..', 'sub.txt'), base64Sub, 'utf-8');
        console.log(`✅ Also restored local sub.txt file.`);

    } catch (err) {
        console.error('\n❌ FAILED TO RESTORE DATABASE');
        if (err.response) {
            console.error(`Supabase Error: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
        } else {
            console.error(err.message);
        }
    }
}

restore();
