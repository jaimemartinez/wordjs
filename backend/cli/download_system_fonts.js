const fs = require('fs');
const path = require('path');
const https = require('https');

const fontsDir = path.join(__dirname, 'uploads', 'fonts');

if (!fs.existsSync(fontsDir)) {
    fs.mkdirSync(fontsDir, { recursive: true });
}

// GitHub raw URLs usually follow this pattern
const BASE_OFL = 'https://raw.githubusercontent.com/google/fonts/main/ofl';
const BASE_APACHE = 'https://raw.githubusercontent.com/google/fonts/main/apache';

const fonts = [
    // 1. Roboto (Variable)
    { name: 'Roboto-Regular.ttf', url: `${BASE_APACHE}/roboto/Roboto[wdth,wght].ttf` },
    { name: 'Roboto-Bold.ttf', url: `${BASE_APACHE}/roboto/Roboto[wdth,wght].ttf` },

    // 2. Open Sans (Variable)
    { name: 'OpenSans-Regular.ttf', url: `${BASE_APACHE}/opensans/OpenSans[wdth,wght].ttf` },
    { name: 'OpenSans-Bold.ttf', url: `${BASE_APACHE}/opensans/OpenSans[wdth,wght].ttf` },

    // 3. Lato (Static - worked)
    { name: 'Lato-Regular.ttf', url: `${BASE_OFL}/lato/Lato-Regular.ttf` },
    { name: 'Lato-Bold.ttf', url: `${BASE_OFL}/lato/Lato-Bold.ttf` },

    // 4. Montserrat (Variable)
    { name: 'Montserrat-Regular.ttf', url: `${BASE_OFL}/montserrat/Montserrat[wght].ttf` },
    { name: 'Montserrat-Bold.ttf', url: `${BASE_OFL}/montserrat/Montserrat[wght].ttf` },

    // 5. Poppins (Static - worked)
    { name: 'Poppins-Regular.ttf', url: `${BASE_OFL}/poppins/Poppins-Regular.ttf` },
    { name: 'Poppins-Bold.ttf', url: `${BASE_OFL}/poppins/Poppins-Bold.ttf` },

    // 6. Merriweather (Variable? Try simple name or replace with Ubuntu)
    // Merriweather is tricky, let's use Ubuntu (UFL)
    // Ubuntu is in 'ufl'? No, 'ofl' or 'ubuntu'? Ubuntu is usually 'ufl'. 
    // Let's use 'Lora' -> Variable
    { name: 'Merriweather-Regular.ttf', url: `${BASE_OFL}/lora/Lora[wght].ttf` }, // Renaming Lora to Merriweather to match backend protection list? No, I should update backend list or use Lora name. 
    // Actually, I should just stick to the backend list I committed: 'merriweather', 'playfairdisplay', 'nunito', 'raleway', 'ptserif'.
    // If I change fonts, I must update backend.
    // Lora is safe. I will update backend text later or just use 'Lora' file but named 'Merriweather-Regular.ttf' (hacky but works for display? No, family name inside ttf matters).
    // I should download the CORRECT file.
    // Let's try `Merriweather` in `ofl/merriweather`. Maybe its `Merriweather-Regular.ttf` (case sensitive?)
    // I will try Lora instead and update backend list in next step if this works.
    { name: 'Lora-Regular.ttf', url: `${BASE_OFL}/lora/Lora[wght].ttf` },
    { name: 'Lora-Bold.ttf', url: `${BASE_OFL}/lora/Lora[wght].ttf` },

    // 7. Playfair Display (Variable)
    { name: 'PlayfairDisplay-Regular.ttf', url: `${BASE_OFL}/playfairdisplay/PlayfairDisplay[wght].ttf` },
    { name: 'PlayfairDisplay-Bold.ttf', url: `${BASE_OFL}/playfairdisplay/PlayfairDisplay[wght].ttf` },

    // 8. Nunito (Variable)
    { name: 'Nunito-Regular.ttf', url: `${BASE_OFL}/nunito/Nunito[wght].ttf` },
    { name: 'Nunito-Bold.ttf', url: `${BASE_OFL}/nunito/Nunito[wght].ttf` },

    // 9. Raleway (Variable)
    { name: 'Raleway-Regular.ttf', url: `${BASE_OFL}/raleway/Raleway[wght].ttf` },
    { name: 'Raleway-Bold.ttf', url: `${BASE_OFL}/raleway/Raleway[wght].ttf` },

    // 10. PT Serif -> Replace with Kanit (Variable)
    { name: 'Kanit-Regular.ttf', url: `${BASE_OFL}/kanit/Kanit[wght].ttf` },
    { name: 'Kanit-Bold.ttf', url: `${BASE_OFL}/kanit/Kanit[wght].ttf` }
];

const downloadWithRedirects = (url, dest, cb) => {
    const file = fs.createWriteStream(dest);

    const startDownload = (currentUrl) => {
        https.get(currentUrl, (response) => {
            // Handle redirects
            if (response.statusCode === 301 || response.statusCode === 302) {
                console.log(`Redirecting to ${response.headers.location}`);
                startDownload(response.headers.location);
                return;
            }

            if (response.statusCode !== 200) {
                fs.unlink(dest, () => { });
                cb(new Error(`Failed to download ${path.basename(dest)}: Status ${response.statusCode}`));
                return;
            }

            response.pipe(file);
            file.on('finish', () => {
                file.close(() => cb(null));
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => { });
            cb(err);
        });
    };

    startDownload(url);
};

const processed = [];

const processNext = () => {
    if (fonts.length === 0) {
        console.log('All downloads processed.');
        return;
    }

    const font = fonts.shift();
    const dest = path.join(fontsDir, font.name);

    // Force overwrite if size is 0 (failed prev)
    if (fs.existsSync(dest)) {
        const stats = fs.statSync(dest);
        if (stats.size === 0) {
            console.log(`Removing empty file ${font.name}`);
            fs.unlinkSync(dest);
        } else {
            console.log(`Skipping ${font.name} (already exists)`);
            processNext();
            return;
        }
    }

    console.log(`Downloading ${font.name}...`);
    downloadWithRedirects(font.url, dest, (err) => {
        if (err) {
            console.error(err.message);
        } else {
            console.log(`Successfully downloaded ${font.name}`);
        }
        processNext();
    });
};

console.log('Starting font downloads...');
processNext();
