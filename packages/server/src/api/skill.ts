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
// packages/server/src/api  →  ../../../../skills/conduit/SKILL.md
const SKILL_PATH = path.resolve(__dirname, '../../../../skills/conduit/SKILL.md');

router.get('/skill', async (_req, res) => {
  try {
    const content = await readFile(SKILL_PATH, 'utf8');
    res
      .set('Cache-Control', 'no-cache')
      .set('Content-Type', 'text/markdown; charset=utf-8')
      .send(content);
  } catch {
    res.status(404).json({ error: 'SKILL.md not found' });
  }
});

export default router;
