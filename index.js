import { fetchConfigs } from './src/fetcher.js';
import { checkLinks } from './src/checker.js';
import { updateHapp } from './src/updater.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
    console.log('Starting VPN Config Updater...');
    
    const links = await fetchConfigs();
    if (links.length === 0) {
        console.log('No links found.');
        return;
    }
    
    const workingLinks = await checkLinks(links);
    
    await updateHapp(workingLinks);
    
    console.log('Done!');
    process.exit(0);
}

main().catch(console.error);
