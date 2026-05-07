import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(process.cwd(), 'data', 'conduit.db'));

const items = db.prepare(`
  SELECT id, source, status, recipientId, content, errorMessage
  FROM outbox
  WHERE source = 'obsidian'
  ORDER BY createdAt DESC
  LIMIT 20
`).all();

for (const item of items) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`ID: ${item.id} | Status: ${item.status} | Recipient: ${item.recipientId}`);
  if (item.errorMessage) {
    console.log(`Error: ${item.errorMessage}`);
  }
  console.log(`Content (first 300 chars):`);
  const content = item.content as string;
  try {
    const parsed = JSON.parse(content);
    console.log(JSON.stringify(parsed, null, 2).slice(0, 500));
  } catch {
    console.log(content.slice(0, 500));
  }
}

