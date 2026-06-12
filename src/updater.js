import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

import axios from 'axios';

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
        
        try {
            // First clear the table (Delete all rows where id is greater than 0, or just not null)
            await axios.delete(`${url}/rest/v1/working_links?id=gt.0`, { headers, timeout: 15000 });
            
            // Insert new links
            const rows = workingLinks.map(item => {
                if (typeof item === 'string') return { link: item };
                return { link: item.link, latency: item.latency, remark: item.remark };
            });
            
            await axios.post(`${url}/rest/v1/working_links`, rows, { headers, timeout: 15000 });
                
            console.log('Successfully updated Supabase with the latest working links!');
        } catch (err) {
            console.error('Failed to update Supabase:', err.response?.data || err.message);
        }
    } else {
        console.log('Skipping Supabase upload. SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not found in .env');
    }
}
