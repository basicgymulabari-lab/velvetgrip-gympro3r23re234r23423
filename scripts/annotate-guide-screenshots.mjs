import { copyFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const outputRoot = "C:\\Users\\HP\\Downloads\\Gym Management Application";
const assetRoot = path.join(process.cwd(), "tutorial", "screenshots", "guide", "gym");
const screenshots = [
  {
    source:
      "C:\\Users\\HP\\Downloads\\gpt Test\\velvetgrip-gympro3r23re234r23423\\tutorial\\screenshots\\login-page.png",
    output: path.join(outputRoot, "Gym Management Application", "00-gym-sign-in.png"),
    assetOutput: path.join(assetRoot, "00-gym-sign-in.png"),
    callouts: [
      { x: 920, y: 289, width: 548, height: 56, number: "1" },
      { x: 920, y: 493, width: 548, height: 170, number: "2" },
      { x: 920, y: 685, width: 548, height: 99, number: "3" },
    ],
  },
  {
    source:
      "C:\\Users\\HP\\AppData\\Local\\Temp\\codex-clipboard-2129bfb1-0b57-41c6-8780-e9290a43ece5.png",
    output: path.join(outputRoot, "Gym Management Application", "04-payment-management.png"),
    assetOutput: path.join(assetRoot, "04-payment-management.png"),
    callouts: [{ x: 1650, y: 121, width: 220, height: 60, number: "1" }],
  },
  {
    source:
      "C:\\Users\\HP\\AppData\\Local\\Temp\\codex-clipboard-734948d4-f34d-486b-a13b-71f9af2d8c1e.png",
    output: path.join(outputRoot, "Gym Management Application", "05-manual-payment-entry.png"),
    assetOutput: path.join(assetRoot, "05-manual-payment-entry.png"),
    callouts: [
      { x: 198, y: 198, width: 580, height: 48, number: "1" },
      { x: 498, y: 451, width: 280, height: 48, number: "2" },
    ],
  },
  {
    source:
      "C:\\Users\\HP\\AppData\\Local\\Temp\\codex-clipboard-fdb244fb-c7ee-4cec-81db-22e7a3d54b72.png",
    output: path.join(outputRoot, "Gym Management Application", "06-staff-access.png"),
    assetOutput: path.join(assetRoot, "06-staff-access.png"),
    callouts: [
      { x: 59, y: 142, width: 685, height: 90, number: "1" },
      { x: 59, y: 488, width: 685, height: 507, number: "2" },
    ],
  },
];

await mkdir(path.join(outputRoot, "Gym Management Application"), { recursive: true });
await mkdir(assetRoot, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const item of screenshots) {
    const image = await readFile(item.source);
    const dataUrl = `data:image/png;base64,${image.toString("base64")}`;
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.setContent(`
      <html><head><style>
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; background: #111114; }
        #frame { position: relative; display: block; width: max-content; line-height: 0; }
        img { display: block; width: auto; height: auto; max-width: none; }
        svg { position: absolute; inset: 0; pointer-events: none; }
        .box { fill: rgba(237, 53, 69, .07); stroke: #ef3340; stroke-width: 5; }
        .dot { fill: #ef3340; stroke: #fff; stroke-width: 2; }
        .num { fill: #fff; font: 700 23px Arial, sans-serif; text-anchor: middle; dominant-baseline: central; }
      </style></head><body>
        <div id="frame"><img id="shot" src="${dataUrl}" alt="Annotated application screenshot" /></div>
      </body></html>
    `);
    const dimensions = await page.locator("#shot").evaluate((image) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    if (!dimensions.width || !dimensions.height) throw new Error(`Could not decode ${item.source}`);
    const boxes = item.callouts
      .map(
        ({ x, y, width, height, number }) => `
          <rect class="box" x="${x}" y="${y}" width="${width}" height="${height}" rx="10" />
          <circle class="dot" cx="${x + 3}" cy="${y + 3}" r="17" />
          <text class="num" x="${x + 3}" y="${y + 3}">${number}</text>
        `,
      )
      .join("");
    await page.locator("#frame").evaluate((frame, { width, height, boxes }) => {
      frame.insertAdjacentHTML(
        "beforeend",
        `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${boxes}</svg>`,
      );
    }, { ...dimensions, boxes });
    await page.locator("#frame").screenshot({ path: item.assetOutput, animations: "disabled" });
    await copyFile(item.assetOutput, item.output);
    console.log(`Created ${item.output} (${dimensions.width}x${dimensions.height})`);
    await page.close();
  }
} finally {
  await browser.close();
}
