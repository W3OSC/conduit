/**
 * GET /api/skill
 *
 * Returns the raw Markdown content of skills/conduit/SKILL.md so the UI
 * (and any other consumer) always reflects the live file rather than a
 * hardcoded snapshot.
 *
 * No auth required — the skill definition is public documentation.
 */

import { readFile } from 'fs/promises';
import { Router } from 'express';
import { fileURLToPath } from 'url';
import path from 'path';

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolution candidates, in order:
//   1. SKILL_PATH env override
//   2. repo layout: packages/server/{src,dist}/api → ../../../../skills/…
//   3. Docker layout: /app/dist/api → /app/skills/…  (the old code only tried
//      the repo layout, which clamps to /skills in the container → 404)
const SKILL_CANDIDATES = [
  process.env.SKILL_PATH,
  path.resolve(__dirname, '../../../../skills/conduit/SKILL.md'),
  path.resolve(__dirname, '../../skills/conduit/SKILL.md'),
].filter((p): p is string => !!p);

async function readSkill(): Promise<string> {
  for (const candidate of SKILL_CANDIDATES) {
    try { return await readFile(candidate, 'utf8'); } catch { /* try next */ }
  }
  throw new Error('SKILL.md not found');
}

router.get('/skill', async (_req, res) => {
  try {
    const content = await readSkill();
    res
      .set('Cache-Control', 'no-cache')
      .set('Content-Type', 'text/markdown; charset=utf-8')
      .send(content);
  } catch {
    res.status(404).json({ error: 'SKILL.md not found' });
  }
});

export default router;
