import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { argosScreenshot } from '@argos-ci/playwright';
import { test } from '@playwright/test';
import type { Page } from '@playwright/test';

type StoryIndex = {
  entries: Record<string, { id: string; title: string; name: string; type: string }>;
};

const indexPath = fileURLToPath(
  new URL('../packages/blade/storybook-site/index.json', import.meta.url),
);
const index: StoryIndex = JSON.parse(readFileSync(indexPath, 'utf-8'));

const only = process.env.ARGOS_ONLY?.split(',').map((s) => s.trim());

// The story's own Chromatic parameters, read at runtime from the built
// Storybook rather than parsed from the sources, so Storybook's own parameter
// inheritance applies: `.storybook/react/preview.tsx` sets
// `chromatic.disableSnapshot: true` globally and each `_KitchenSink.*` story
// re-opts in with `disableSnapshot: false`, exactly as Chromatic resolves it.
type ChromaticParams = {
  disableSnapshot?: boolean;
  delay?: number;
};

// Loading indicators legitimately keep `aria-busy='true'` for as long as they
// are rendered, so waiting for it to clear never settles on their stories.
const LOADER = /load(ing|er)|skeleton|spinner|progress|busy/i;

// Chromatic's default viewport, which is what applies here: no story in this
// repo declares `chromatic.viewports` or `chromatic.modes`.
const VIEWPORT_WIDTH = 1200;
const VIEWPORT_HEIGHT = 900;

const stories = Object.values(index.entries).filter(
  (entry) => entry.type === 'story' && (!only || only.includes(entry.id)),
);

// Wait for Storybook's own render cycle. Storybook 8+ exposes the active
// renders on `__STORYBOOK_PREVIEW__.storyRenders`; match the one for this
// story (fall back to the latest). Some stories render in a portal (modals,
// popovers, menus, toasts) and leave #storybook-root empty, so don't wait on
// the root.
const waitForStoryRendered = (page: Page, storyId: string) =>
  page.waitForFunction((id) => {
    const renders =
      ((window as unknown) as {
        __STORYBOOK_PREVIEW__?: { storyRenders?: { id?: string; phase?: string }[] };
      }).__STORYBOOK_PREVIEW__?.storyRenders ?? [];
    const render = renders.find((r) => r.id === id) ?? renders[renders.length - 1];
    return render?.phase === 'completed' || render?.phase === 'finished';
  }, storyId);

// Read the merged `parameters.chromatic` off the rendered story.
const readChromaticParams = (page: Page, storyId: string): Promise<ChromaticParams> =>
  page.evaluate((id) => {
    const renders =
      ((window as unknown) as {
        __STORYBOOK_PREVIEW__?: {
          storyRenders?: {
            id?: string;
            story?: { parameters?: { chromatic?: Record<string, unknown> } };
          }[];
        };
      }).__STORYBOOK_PREVIEW__?.storyRenders ?? [];
    const render = renders.find((r) => r.id === id) ?? renders[renders.length - 1];
    return (render?.story?.parameters?.chromatic ?? {}) as ChromaticParams;
  }, storyId);

for (const story of stories) {
  test(`${story.title} › ${story.name}`, async ({ page }) => {
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    await waitForStoryRendered(page, story.id);

    const params = await readChromaticParams(page, story.id);

    // Honour the story's own Chromatic opt-out. Here that is the global
    // opt-out from `preview.tsx`: only the KitchenSink stories are captured.
    test.skip(params.disableSnapshot === true, 'story opts out of snapshots (chromatic parameter)');

    const isLoader = LOADER.test(`${story.title} ${story.name}`);

    // Honour the story's own `chromatic.delay` (the Drawer, DatePicker and
    // Menu kitchen sinks each wait 700ms for their overlay to settle).
    if (params.delay) {
      await page.waitForTimeout(params.delay);
    }

    // Components measure text before the webfonts finish loading and only
    // re-measure when a ResizeObserver fires. Wait for the fonts, then nudge
    // the viewport one pixel and back so size observers re-run with the final
    // font metrics.
    await page.evaluate(() => document.fonts.ready);
    await page.setViewportSize({ width: VIEWPORT_WIDTH + 1, height: VIEWPORT_HEIGHT });
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

    // Wait until the story markup holds still across two consecutive samples,
    // capped so endlessly looping stories still capture. The kitchen sinks
    // compose every story of a component on one page, and Framer Motion drives
    // entrance animations that neither `prefers-reduced-motion` nor CSS
    // animation stabilization covers.
    let previousMarkup = '';
    let stableSamples = 0;
    for (let i = 0; i < 40 && stableSamples < 2; i++) {
      const markup = await page.evaluate(() => document.body.innerHTML);
      stableSamples = markup === previousMarkup ? stableSamples + 1 : 0;
      previousMarkup = markup;
      if (stableSamples < 2) {
        await page.waitForTimeout(250);
      }
    }

    // Scrollable containers (overflowing tables, carousels, virtualized lists)
    // may settle on a non-deterministic offset: pin every scroll position.
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (el.scrollLeft !== 0) {
          el.scrollLeft = 0;
        }
        if (el.scrollTop !== 0) {
          el.scrollTop = 0;
        }
      }
    });

    // SVG SMIL animations (`<animate>`) ignore `prefers-reduced-motion` and
    // aren't covered by Argos's animation stabilization, so a capture lands at
    // an arbitrary point of the timeline. Rewind them and pause.
    await page.evaluate(() => {
      for (const svg of Array.from(document.querySelectorAll('svg'))) {
        if (typeof svg.pauseAnimations !== 'function') {
          continue;
        }
        svg.setCurrentTime(0);
        svg.pauseAnimations();
      }
    });

    await argosScreenshot(page, story.id, {
      stabilize: { waitForAriaBusy: !isLoader },
    });
  });
}
