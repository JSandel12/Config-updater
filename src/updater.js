import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

export async function updateHapp(workingLinks) {
    if (workingLinks.length === 0) {
        console.log('No working links found. Nothing to update.');
        return;
    }
    
    const rawLinks = workingLinks.join('\n');
    const base64Sub = Buffer.from(rawLinks).toString('base64');
    
    const outputPath = path.join(process.cwd(), 'sub.txt');
    fs.writeFileSync(outputPath, base64Sub, 'utf-8');
    
    console.log(`Saved ${workingLinks.length} working links to ${outputPath} (Base64 subscription format).`);
    
    // Upload to Supabase
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.log('Uploading working links to Supabase...');
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
            global: {
                WebSocket: WebSocket
            }
        });
        
        try {
            // First clear the table
            const { error: deleteError } = await supabase
                .from('working_links')
                .delete()
                .neq('id', 0); // Delete all rows (id > 0 or anything)
                
            if (deleteError) {
                 console.error('Failed to delete old links:', deleteError);
                 throw deleteError;
            }
            
            // Insert new links
            const rows = workingLinks.map(link => ({ link }));
            const { error: insertError } = await supabase
                .from('working_links')
                .insert(rows);
                
            if (insertError) {
                 console.error('Failed to insert new links:', insertError);
                 throw insertError;
            }
            
            console.log('Successfully updated Supabase with the latest working links!');
        } catch (err) {
            console.error('Failed to update Supabase:', err.message);
        }
    } else {
        console.log('Skipping Supabase upload. SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not found in .env');
    }
}
