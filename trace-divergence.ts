/**
 * Try to identify the source of divergence between validation and execution
 */

// Simulate the exact issue: validation passes different edits vs execution
const testActionJson = {
  action: 'patch_file',
  path: 'test.md',
  edits: [
    {
      search: '#### Corn / OpSec Services',
      position: 'after',
      content: '\n\nAdded'
    }
  ]
};

const fileContent = `# Document

#### Corn / OpSec Services

Some content`;

// VALIDATION LOGIC (from outbox.ts)
function validateSearch(): { success: boolean; error?: string } {
  let current = fileContent;
  
  for (let i = 0; i < testActionJson.edits.length; i++) {
    // Note the 'as' type assertion that makes properties optional
    const { search, position = 'replace', replace = '', content: insertContent = '' } = testActionJson.edits[i] as {
      search?: string; position?: string; replace?: string; content?: string;
    };
    
    console.log('VALIDATION:');
    console.log('  search:', JSON.stringify(search), 'type:', typeof search, 'length:', search?.length);
    console.log('  insertContent:', JSON.stringify(insertContent), 'type:', typeof insertContent);
    
    if (!search) {
      return { success: false, error: 'search is empty' };
    }
    
    let count = 0;
    let pos = current.indexOf(search);
    const firstPos = pos;
    
    while (pos !== -1) {
      count++;
      if (count > 1) break;
      pos = current.indexOf(search, pos + 1);
    }
    
    console.log('  Count:', count);
    console.log('  Search found:', count > 0);
    
    if (count === 0) {
      return { success: false, error: `Edit ${i + 1}: not found` };
    }
    if (count > 1) {
      return { success: false, error: `Edit ${i + 1}: multiple matches` };
    }
    
    // Apply edit
    if (position === 'after') {
      const afterPos = firstPos + search.length;
      current = current.slice(0, afterPos) + insertContent + current.slice(afterPos);
    }
  }
  
  return { success: true };
}

// EXECUTION LOGIC (from obsidian.ts)
function executeSearch(): { success: boolean; error?: string } {
  let current = fileContent;
  
  for (let i = 0; i < testActionJson.edits.length; i++) {
    // No 'as' type assertion - properties are required
    const { search, position = 'replace', replace = '', content = '' } = testActionJson.edits[i];
    
    console.log('EXECUTION:');
    console.log('  search:', JSON.stringify(search), 'type:', typeof search, 'length:', search?.length);
    console.log('  content:', JSON.stringify(content), 'type:', typeof content);
    
    if (!search) {
      return { success: false, error: 'search is empty' };
    }
    
    let count = 0;
    let pos = current.indexOf(search);
    const firstPos = pos;
    
    while (pos !== -1) {
      count++;
      if (count > 1) break;
      pos = current.indexOf(search, pos + 1);
    }
    
    console.log('  Count:', count);
    console.log('  Search found:', count > 0);
    
    if (count === 0) {
      return { success: false, error: `Edit ${i + 1}: not found` };
    }
    if (count > 1) {
      return { success: false, error: `Edit ${i + 1}: multiple matches` };
    }
    
    // Apply edit
    if (position === 'after') {
      const afterPos = firstPos + search.length;
      current = current.slice(0, afterPos) + content + current.slice(afterPos);
    }
  }
  
  return { success: true };
}

console.log('VALIDATION RESULT:');
const valResult = validateSearch();
console.log('  Result:', valResult);

console.log('\nEXECUTION RESULT:');
const execResult = executeSearch();
console.log('  Result:', execResult);

