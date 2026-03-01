import { expect, browser, $ } from '@wdio/globals';

describe('Lotus Teaching Invoices', () => {
  it('should boot the native macOS window and render React tabs', async () => {
    // Wait for React to mount in the native window
    await browser.pause(2000);

    // Verify the HTML document loaded and the React root is present
    const root = await $('#root');
    await expect(root).toBeExisting();

    // Find the Calendar Tab using standard CSS selectors and text check
    // WebdriverIO translates `button=Text` to advanced XPaths that safari driver struggles with
    const buttons = await $$('button');
    const labels = await Promise.all(buttons.map((b) => b.getText()));

    // Verify Calendar tab exists
    expect(labels).toContain('Calendar');
    expect(labels).toContain('Rates & Config');
  });

  it('should navigate to the Rates & Config tab', async () => {
    const buttons = await $$('button');
    for (const btn of buttons) {
      if ((await btn.getText()) === 'Rates & Config') {
        await btn.click();
        break;
      }
    }

    // Wait a frame for transition
    await browser.pause(500);

    // Ensure that form labels render, confirming React state transition
    const nameLabel = await $('label*=Name'); // Partial text works better or we can check input
    await expect(nameLabel).toBeExisting();
  });
});
