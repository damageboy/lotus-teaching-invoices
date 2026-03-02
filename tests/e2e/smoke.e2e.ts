import { expect, browser, $ } from '@wdio/globals';

describe('Lotus Teaching Invoices', () => {
  it('should boot the native macOS window and render React tabs', async () => {
    // Wait for React to mount in the native window
    await browser.pause(2000);

    // Output DOM state to debug why it might be empty
    const html = await $('body').getHTML();
    console.log('PAGE HTML:', html);

    // Find the Calendar Tab
    const calendarTabButton = await $('button=Calendar');
    await expect(calendarTabButton).toBeExisting();

    const refreshButton = await $('button*=Refresh');
    await expect(refreshButton).toBeExisting();
  });

  it('should navigate to the Rates & Config tab', async () => {
    const ratesTabButton = await $('button=Rates & Config');
    await ratesTabButton.click();

    // Ensure that form labels render, confirming React state transition
    const nameLabel = await $('label=Name');
    await expect(nameLabel).toBeExisting();
  });
});
