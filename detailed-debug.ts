/**
 * Detailed debugging of actual edits array destructuring
 */

interface ObsidianPatchEdit {
  search: string;
  position?: 'replace' | 'before' | 'after';
  replace?: string;
  content?: string;
}

// Test case: how does the destructuring in validateObsidianPatchFile handle the edits array?
const testContent = JSON.stringify({
  action: 'patch_file',
  path: 'test.md',
  edits: [
    {
      search: '#### Corn / OpSec Services',
      position: 'after',
      content: '\n\nAdded content'
    }
  ]
});

console.log('TEST 1: Parsing JSON action');
console.log('─'.repeat(60));

let action: { action?: string; path?: string; edits?: Array<{ search?: string }>; vaultId?: number };
try {
  action = JSON.parse(testContent);
} catch (e) {
  console.log('Failed to parse JSON:', e);
  process.exit(1);
}

console.log('Parsed action:', action);
console.log('action.edits type:', Array.isArray(action.edits));
console.log('action.edits length:', action.edits?.length);

if (action.edits && action.edits.length > 0) {
  const firstEdit = action.edits[0];
  console.log('\nFirst edit object:', firstEdit);
  console.log('firstEdit.search type:', typeof firstEdit.search);
  console.log('firstEdit.search value:', JSON.stringify(firstEdit.search));
  
  // Now simulate the validation destructuring
  const { search, position = 'replace', replace = '', content: insertContent = '' } = firstEdit as {
    search?: string; position?: string; replace?: string; content?: string;
  };
  
  console.log('\nAfter destructuring:');
  console.log('search type:', typeof search);
  console.log('search value:', JSON.stringify(search));
  console.log('search length:', search?.length);
  console.log('!search evaluates to:', !search);
  console.log('position:', position);
  console.log('insertContent:', JSON.stringify(insertContent));
}

// TEST 2: What if search is in a different position or missing?
console.log('\n\nTEST 2: Missing or incorrect property names');
console.log('─'.repeat(60));

const malformedContent = JSON.stringify({
  action: 'patch_file',
  path: 'test.md',
  edits: [
    {
      // Note: 'search_string' instead of 'search'
      search_string: '#### Corn / OpSec Services',
      position: 'after'
    }
  ]
});

action = JSON.parse(malformedContent);
if (action.edits && action.edits.length > 0) {
  const edit = action.edits[0] as any;
  console.log('Edit object keys:', Object.keys(edit));
  const { search } = edit;
  console.log('Destructured search:', search);
  console.log('search is undefined:', search === undefined);
}

// TEST 3: What if the array element is malformed?
console.log('\n\nTEST 3: Array element type checking');
console.log('─'.repeat(60));

const editsData = [
  {
    search: '#### Corn / OpSec Services',
    position: 'after' as const,
    content: 'Added'
  },
  null,  // Null element
  {
    search: 'Another search',
    position: 'before' as const,
    content: 'Prefix'
  }
];

for (let i = 0; i < editsData.length; i++) {
  const edit = editsData[i];
  console.log(`\nEdit ${i}:`, edit);
  
  if (edit === null) {
    console.log('  -> Edit is null!');
    const { search } = edit as any;
    console.log('  -> search from null:', search);
  } else {
    const { search } = edit;
    console.log('  -> search:', search);
  }
}

// TEST 4: String vs String object
console.log('\n\nTEST 4: String primitive vs String object');
console.log('─'.repeat(60));

const stringPrimitive = 'primitive';
const stringObject = new String('object');

console.log('Primitive - typeof:', typeof stringPrimitive);
console.log('Primitive - indexOf works:', stringPrimitive.indexOf('i'));
console.log('Object - typeof:', typeof stringObject);
console.log('Object - indexOf works:', (stringObject as any).indexOf('i'));

const testFile = 'Line 1\nLine 2\nLine 3';
console.log('\nWith testFile:');
console.log('Using primitive:', testFile.indexOf(stringPrimitive));
console.log('Using object:', testFile.indexOf(stringObject));
console.log('Using String(object):', testFile.indexOf(String(stringObject)));

