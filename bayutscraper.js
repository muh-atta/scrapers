const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // Make sure you've installed this: npm install node-fetch@2

async function scrapeProperty(url) {
    const browser = await chromium.launch({ headless: false }); // Keep headless: false for visual debugging
    const page = await browser.newPage();

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Extract property ID from URL
        const urlParts = url.split('/');
        const propertyId = urlParts[urlParts.length - 1].split('.')[0].replace('details-', '');
        if (!propertyId) {
            console.error('Could not extract property ID from URL:', url);
            return;
        }

        console.log(`Scraping property with ID: ${propertyId}`);

        // --- Extracting Data (keeping previous improvements) ---

        // Title
        const title = await page.locator('div[aria-label="Property overview"] h1').textContent().catch(() => null);

        // Price
        const price = await page.locator('span[aria-label="Price"]').textContent().catch(() => null);

        // Description (handle expansion if needed)
        let description = await page.locator('div[aria-label="Property description"]').textContent().catch(() => null);
        const expandButton = await page.locator('div[role="button"][aria-label="View More"]').first(); // Corrected selector for "Read More"
        if (expandButton && await expandButton.isVisible()) {
            console.log('Clicking "Read More" for description...');
            await expandButton.click();
            await page.waitForTimeout(500); // Give it a moment to expand
            description = await page.locator('div[aria-label="Property description"]').textContent().catch(() => description);
        }
        
        // Property Details (e.g., bedrooms, bathrooms, area)
        const details = {};
        const detailListItems = await page.locator('ul[aria-label="Property details"] li').all();

        for (const el of detailListItems) {
            let label = null;
            let value = null;

            const labelSpan = await el.locator('span.ed0db22a').first();
            if (labelSpan) {
                label = await labelSpan.textContent().catch(() => null);
            }
            if (!label) {
                const divLabel = await el.locator('div.ed0db22a').first();
                if (divLabel) {
                    label = await divLabel.textContent().catch(() => null);
                }
            }

            const valueSpanByAria = await el.locator('span[aria-label]').first();
            if (valueSpanByAria) {
                value = await valueSpanByAria.textContent().catch(() => null);
            }
            if (!value) {
                const valueSpanByClass = await el.locator('span._2fdf7fc5').first();
                if (valueSpanByClass) {
                    value = await valueSpanByClass.textContent().catch(() => null);
                }
            }
            
            if (label && label.includes('TruCheck') && !value) {
                const truCheckSpan = await el.locator('span[aria-label="Trucheck date"]').first();
                if (truCheckSpan) {
                    value = await truCheckSpan.textContent().catch(() => null);
                }
            }

            if (label && value) {
                details[label.trim().toLowerCase().replace(/ /g, '_').replace(/™/g, '')] = value.trim();
            }
        }

        // Location
        const location = await page.locator('div.e4fd45f0[aria-label="Property header"]').textContent().catch(() => null);

        // Agent/Agency Name
        const agentName = await page.locator('a[aria-label="Agent name"]').textContent().catch(() => null);
        const agencyName = await page.locator('h3[aria-label="Agency name"]').textContent().catch(() => null);


        // --- Image Scraping ---
        let imageUrls = [];
        const viewGalleryButton = await page.locator('div[role="button"][aria-label="View gallery"]').first();
     if (viewGalleryButton && await viewGalleryButton.isVisible()) {
            console.log('Clicking "View gallery" button...');
            await viewGalleryButton.click();

            const galleryDialog = await page.locator('div[aria-label="Gallery Dialog"]');
            await galleryDialog.waitFor({ state: 'visible', timeout: 15000 });
            console.log('Gallery dialog is now visible.');

            // IMPORTANT CHANGE: Make waitForLoadState non-blocking
            try {
                // You can increase the timeout here if you want to give it more time, e.g., 60 seconds
                await page.waitForLoadState('networkidle', { timeout: 45000 }); // Increased to 45 seconds
                console.log('Network idle after gallery dialog opened.');
            } catch (error) {
                console.warn(`Warning: page.waitForLoadState('networkidle') timed out after gallery opened. Proceeding anyway. Error: ${error.message}`);
            }

            // OPTIONAL BUT HIGHLY RECOMMENDED FOR LAZY LOADING: Scroll the gallery to load all images
            const galleryGrid = await page.locator('div[aria-label="Gallery dialog photo grid"]');
            if (galleryGrid) {
                console.log('Attempting to scroll gallery to load all images...');
                await galleryGrid.evaluate(async (element) => {
                    const scrollHeight = element.scrollHeight;
                    let currentScroll = 0;
                    const scrollStep = element.clientHeight;
                    const maxScrollAttempts = 20;

                    for (let i = 0; i < maxScrollAttempts; i++) {
                        const prevScrollTop = element.scrollTop;
                        element.scrollTop = currentScroll;
                        currentScroll += scrollStep;
                        await new Promise(resolve => setTimeout(resolve, 500));
                        
                        if (element.scrollTop === prevScrollTop && currentScroll > scrollHeight) {
                            console.log('Reached end of scrollable area within browser context.');
                            break;
                        }
                        if (currentScroll > scrollHeight + (scrollStep * 2)) {
                            console.log('Exceeded scroll height limit, breaking within browser context.');
                            break;
                        }
                    }
                    element.scrollTop = 0;
                    console.log('Finished scrolling gallery within browser context.');
                });
                console.log('Gallery scrolling completed.');
                await page.waitForTimeout(2000); // Give more time after scrolling for images to load
                
                // IMPORTANT CHANGE: Make waitForLoadState non-blocking again
                try {
                    await page.waitForLoadState('networkidle', { timeout: 45000 }); // Increased to 45 seconds
                    console.log('Network idle after gallery scrolling.');
                } catch (error) {
                    console.warn(`Warning: page.waitForLoadState('networkidle') timed out after gallery scrolling. Proceeding anyway. Error: ${error.message}`);
                }
            }

            // Now, get image URLs by directly querying elements and getting attributes
            const galleryImageLocators = await page.locator('div[aria-label="Gallery dialog photo grid"] picture img').all();
            console.log(`Found ${galleryImageLocators.length} image elements in gallery after potential scrolling.`);

            const urls = new Set();
            for (const imgLocator of galleryImageLocators) {
                try {
                    await imgLocator.waitFor(el => el.getAttribute('src') && el.getAttribute('src').length > 0, { timeout: 5000 }).catch(() => {
                        return imgLocator.waitFor(el => el.getAttribute('data-src') && el.getAttribute('data-src').length > 0, { timeout: 5000 });
                    });

                    const src = await imgLocator.getAttribute('src').catch(() => null);
                    const dataSrc = await imgLocator.getAttribute('data-src').catch(() => null);

                    const finalSrc = src || dataSrc;
                    console.log('--------------'+finalSrc);
                    if (finalSrc //&& !finalSrc.includes('thumb')
                    ) {
                        console.log(`Attempting to add URL: ${finalSrc}`);
                        urls.add(finalSrc.replace('-400x300', '-800x600').replace('-120x90', '-800x600').replace('-240x180', '-800x600'));
                    } else {
                        console.log(`Skipping image: src=${src}, data-src=${dataSrc} (might be thumb or empty/not loaded)`);
                    }
                } catch (imgAttrError) {
                    console.warn(`Could not get src/data-src for an image locator: ${imgAttrError.message}`);
                }
            }
            imageUrls = Array.from(urls);
            console.log('Collected unique image URLs:', imageUrls);

            // Close the gallery dialog
            const closeButton = await page.locator('button[aria-label="Close button"]').first();
            if (closeButton && await closeButton.isVisible()) {
                console.log('Closing gallery dialog...');
                await closeButton.click();
                await page.waitForTimeout(1000);
            }

        } else {
            console.log('No "View gallery" button found or visible. Attempting to scrape main image only.');
            const mainImage = await page.locator('div[aria-label="Property image"] picture img').first();
            if (mainImage) {
                const src = await mainImage.getAttribute('src');
                if (src && !src.includes('thumb')) {
                    imageUrls.push(src.replace('-400x300', '-800x600'));
                }
            }
            console.log('Main image URL:', imageUrls[0] || 'N/A');
        }
        // Create directory for images
        const imagesDir = path.join(__dirname, 'images', propertyId);
        if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
        }

        const downloadedImagePaths = [];
        if (imageUrls.length > 0) {
            console.log(`Attempting to download ${imageUrls.length} images.`);
            for (let i = 0; i < imageUrls.length; i++) {
                const imageUrl = imageUrls[i];
                if (imageUrl) {
                    try {
                        console.log(`Downloading image ${i + 1}/${imageUrls.length}: ${imageUrl}`);
                        const response = await fetch(imageUrl); // Use node-fetch
                        if (response.ok) {
                            const imageBuffer = await response.buffer();
                            const imageExtension = path.extname(new URL(imageUrl).pathname) || '.jpeg';
                            const imageFileName = `image_${i + 1}${imageExtension}`;
                            const imagePath = path.join(imagesDir, imageFileName);
                            fs.writeFileSync(imagePath, imageBuffer);
                            downloadedImagePaths.push(imagePath);
                            console.log(`Successfully downloaded: ${imageFileName}`);
                        } else {
                            console.warn(`Failed to download image from ${imageUrl}: HTTP Status ${response.status}`);
                        }
                    } catch (imgErr) {
                        console.error(`Error downloading image ${imageUrl}: ${imgErr.message}`);
                    }
                }
            }
            console.log('All image downloads attempted.');
        } else {
            console.log('No image URLs collected to download.');
        }


        // --- Save to JSON ---
        const propertyData = {
            id: propertyId,
            url: url,
            title: title ? title.trim() : null,
            price: price ? price.trim() : null,
            description: description ? description.trim() : null,
            location: location ? location.trim() : null,
            details: details,
            agentName: agentName ? agentName.trim() : null,
            agencyName: agencyName ? agencyName.trim() : null,
            images: downloadedImagePaths,
        };

        const jsonFileName = path.join(__dirname, `${propertyId}.json`);
        fs.writeFileSync(jsonFileName, JSON.stringify(propertyData, null, 2));
        console.log(`Data saved to ${jsonFileName}`);

    } catch (error) {
        console.error(`Error scraping ${url}:`, error);
    } finally {
        await browser.close();
    }
}

// Example usage:
const targetUrl = 'https://www.bayut.sa/en/property/details-87607079.html';
scrapeProperty(targetUrl);