import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

import axios from 'axios';
import https from 'https';

export async function updateHapp(workingLinks) {
    if (workingLinks.length === 0) {
        console.log('No working links found. Nothing to update.');
        return;
    }
    
    const rawLinks = workingLinks.map(obj => typeof obj === 'string' ? obj : obj.link).join('\n');
    const base64Sub = Buffer.from(rawLinks).toString('base64');
    
    const outputPath = path.join(process.cwd(), 'sub.txt');
    fs.writeFileSync(outputPath, base64Sub, 'utf-8');
    
    console.log(`Saved ${workingLinks.length} working links to ${outputPath} (Base64 subscription format).`);
    
    // Upload to Supabase using Axios (Bypasses Termux native fetch DNS bug)
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.log('Uploading working links to Supabase via Axios...');
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        const headers = {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
        };
        
        // Force IPv4 to completely bypass Termux IPv6 DNS hanging issues
        const httpsAgent = new https.Agent({ family: 4 });
        
        try {
            if (workingLinks.length < 5) {
                console.error(`\n[CRITICAL] Only ${workingLinks.length} working links found! Aborting DB update to prevent breaking clients.`);
                return;
            }

            console.log(`[DEBUG] Attempting to clear old links from Supabase (${url})...`);
            // First clear the table (Delete all rows where id is greater than 0, or just not null)
            const deleteRes = await axios.delete(`${url}/rest/v1/working_links?id=gt.0`, { headers, timeout: 15000, httpsAgent });
            console.log(`[DEBUG] Delete successful. Status: ${deleteRes.status}`);
            
            // Insert new links
            const rows = workingLinks.map(item => {
                if (typeof item === 'string') return { link: item };
                return { link: item.link, latency: item.latency, remark: item.remark };
            });
            
            console.log(`[DEBUG] Attempting to insert ${rows.length} new links in smaller chunks...`);
            
            // Chunk the rows into batches of 5 to avoid MTU/PMTUD fragmentation drops on LTE
            const chunkSize = 5;
            for (let i = 0; i < rows.length; i += chunkSize) {
                const chunk = rows.slice(i, i + chunkSize);
                console.log(`[DEBUG] Inserting chunk ${Math.floor(i/chunkSize) + 1}/${Math.ceil(rows.length/chunkSize)}...`);
                const postRes = await axios.post(`${url}/rest/v1/working_links`, chunk, { headers, timeout: 15000, httpsAgent });
                if (postRes.status !== 201 && postRes.status !== 200) {
                     throw new Error(`Unexpected status ${postRes.status} on chunk insert`);
                }
            }
            console.log(`[DEBUG] All chunks inserted successfully.`);
                
            console.log('Successfully updated Supabase with the latest working links!');
        } catch (err) {
            console.error('\n======================================');
            console.error('FAILED TO UPDATE SUPABASE');
            if (err.response) {
                console.error('Supabase returned an error:');
                console.error(`Status: ${err.response.status}`);
                console.error(`Data: ${JSON.stringify(err.response.data, null, 2)}`);
            } else if (err.request) {
                console.error('No response received from Supabase. The connection timed out or was blocked.');
                console.error(`Error message: ${err.message}`);
                console.error(`Code: ${err.code}`);
            } else {
                console.error('An unexpected error occurred:');
                console.error(err.message);
            }
            console.error('======================================\n');
        }
    } else {
        console.log('Skipping Supabase upload. SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not found in .env');
    }
}
