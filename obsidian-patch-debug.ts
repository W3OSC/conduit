/**
 * Obsidian Patch File Search Mechanism - Comprehensive Debug Analysis
 *
 * This script replicates the exact validation and execution logic from both
 * validateObsidianPatchFile (outbox.ts) and executeAction (obsidian.ts) to
 * identify any differences in how search strings are processed.
 */

import fs from 'fs';
import path from 'path';

// ────────────────────────────────────────────────────────────────────────────
// TEST DATA & SETUP
// ────────────────────────────────────────────────────────────────────────────

interface TestEdit {
  search: string;
  position?: 'replace' | 'before' | 'after';
  replace?: string;
  content?: string;
}

interface TestScenario {
  name: string;
  fileContent: string;
  edits: TestEdit[];
  expectedResult: 'pass' | 'fail';
  expectedError?: string;
}

// Real test case from user report
const testScenarios: TestScenario[] = [
  {
    name: 'User reported case - Corn/OpSec Services heading',
    fileContent: `# Some Document

#### Corn / OpSec Services

Some content here`,
    edits: [
      {
        search: '#### Corn / OpSec Services',
        position: 'after',
        content: '\n\nAdded content'
      }
    ],
    expectedResult: 'pass'
  },

  {
    name: 'Search with em dash (em dash variant)',
    fileContent: `#### Corn — OpSec Services\n\nContent`,
    edits: [
      {
        search: '#### Corn — OpSec Services',
        position: 'after',
        content: '\nNew content'
      }
    ],
    expectedResult: 'pass'
  },

  {
    name: 'Search with forward slash',
    fileContent: `## Section / Subsection\n\nContent`,
    edits: [
      {
        search: '## Section / Subsection',
        position: 'before',
        content: 'Prefix: '
      }
    ],
    expectedResult: 'pass'
  },

  {
    name: 'Search with brackets',
    fileContent: `## [Bracketed] Section\n\nContent`,
    edits: [
      {
        search: '## [Bracketed] Section',
        replace: '## Updated [Bracketed] Section'
      }
    ],
    expectedResult: 'pass'
  },

  {
    name: 'Search not found',
    fileContent: `## Some Section\n\nContent`,
    edits: [
      {
        search: '## NonExistent Section',
        replace: 'replacement'
      }
    ],
    expectedResult: 'fail',
    expectedError: 'search string not found'
  },

  {
    name: 'Multiple matches',
    fileContent: `## Section\n\nSome text\n## Section\n\nMore text`,
    edits: [
      {
        search: '## Section',
        replace: '## Updated'
      }
    ],
    expectedResult: 'fail',
    expectedError: 'matches more than one'
  },

  {
    name: 'Sequential edits - first modifies, second searches in modified',
    fileContent: `Line 1\nLine 2\nLine 3`,
    edits: [
      {
        search: 'Line 2',
        replace: 'MODIFIED'
      },
      {
        search: 'MODIFIED',
        replace: 'FINAL'
      }
    ],
    expectedResult: 'pass'
  },

  {
    name: 'Unicode in search string',
    fileContent: `Section with café and naïve\n\nContent`,
    edits: [
      {
        search: 'Section with café and naïve',
        position: 'after',
        content: '\n- Added item'
      }
    ],
    expectedResult: 'pass'
  },

  {
    name: 'Whitespace sensitivity - tab vs spaces',
    fileContent: `\t## Indented with tab\n\nContent`,
    edits: [
      {
        search: '\t## Indented with tab',
        replace: '  ## Indented with spaces'
      }
    ],
    expectedResult: 'pass'
  },

  {
    name: 'CRLF vs LF line endings',
    fileContent: `Line 1\r\nLine 2\r\nLine 3`,
    edits: [
      {
        search: 'Line 2',
        replace: 'MODIFIED'
      }
    ],
    expectedResult: 'pass'
  },
];

// ────────────────────────────────────────────────────────────────────────────
// VALIDATION LOGIC (from outbox.ts:validateObsidianPatchFile)
// ────────────────────────────────────────────────────────────────────────────

function validatePatchLogic(fileContent: string, edits: TestEdit[]): {
  success: boolean;
  error?: string;
  details: any;
} {
  const details: any = {
    edits: [],
    validationSteps: []
  };

  let current = fileContent;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const { search, position = 'replace', replace = '', content: insertContent = '' } = edit;
    const editDetails: any = {
      editIndex: i,
      search: {
        value: search,
        length: search?.length ?? 0,
        type: typeof search,
        isUndefined: search === undefined,
        isNull: search === null,
        preview: search?.slice(0, 50)?.replace(/\n/g, '↵'),
      },
      position,
    };

    details.validationSteps.push({
      step: `Edit ${i}`,
      currentContentLength: current.length,
      currentContentPreview: current.slice(0, 100).replace(/\n/g, '↵'),
    });

    if (!search) {
      return {
        success: false,
        error: `Edit ${i + 1}: search string must not be empty`,
        details: { ...details, failedAt: i }
      };
    }

    // ── CRITICAL: Search logic (from outbox.ts:232-238)
    let count = 0;
    let pos = current.indexOf(search);
    const firstPos = pos;

    editDetails.searchLogic = {
      initialIndexOf: pos,
      firstPosValue: firstPos,
      searchFoundAt: pos !== -1
    };

    const matchPositions: number[] = [];
    if (pos !== -1) {
      matchPositions.push(pos);
    }

    while (pos !== -1) {
      count++;
      if (count > 1) {
        // Only count up to 2 to detect duplicates
        matchPositions.push(pos);
        break;
      }
      pos = current.indexOf(search, pos + 1);
      if (pos !== -1) {
        matchPositions.push(pos);
      }
    }

    editDetails.matchingLogic = {
      countValue: count,
      allMatchPositions: matchPositions,
      loopExecuted: matchPositions.length > 0,
    };

    if (count === 0) {
      editDetails.resultType = 'NOT_FOUND';
      const searchPreview = search.length > 120
        ? search.slice(0, 120).replace(/\n/g, '↵') + '…'
        : search.replace(/\n/g, '↵');
      return {
        success: false,
        error: `Edit ${i + 1}: search string not found in file.\nSearch string (${search.length} chars): "${searchPreview}"`,
        details: { ...details, failedAt: i, failedEdit: editDetails }
      };
    }

    if (count > 1) {
      editDetails.resultType = 'MULTIPLE_MATCHES';
      const searchPreview = search.length > 120
        ? search.slice(0, 120).replace(/\n/g, '↵') + '…'
        : search.replace(/\n/g, '↵');
      return {
        success: false,
        error: `Edit ${i + 1}: search string matches more than one location in the file.\nSearch string (${search.length} chars): "${searchPreview}"`,
        details: { ...details, failedAt: i, failedEdit: editDetails }
      };
    }

    editDetails.resultType = 'MATCHED_ONCE';

    // Apply edit to current content (same as validation)
    if (position === 'before') {
      current = current.slice(0, firstPos) + insertContent + current.slice(firstPos);
      editDetails.appliedAs = 'before';
    } else if (position === 'after') {
      const afterPos = firstPos + search.length;
      current = current.slice(0, afterPos) + insertContent + current.slice(afterPos);
      editDetails.appliedAs = 'after';
    } else {
      current = current.slice(0, firstPos) + replace + current.slice(firstPos + search.length);
      editDetails.appliedAs = 'replace';
    }

    editDetails.resultAfterApply = {
      newContentLength: current.length,
      preview: current.slice(0, 100).replace(/\n/g, '↵')
    };

    details.edits.push(editDetails);
  }

  return {
    success: true,
    details
  };
}

// ────────────────────────────────────────────────────────────────────────────
// EXECUTION LOGIC (from obsidian.ts:executeAction)
// ────────────────────────────────────────────────────────────────────────────

function executePatchLogic(fileContent: string, edits: TestEdit[]): {
  success: boolean;
  error?: string;
  details: any;
} {
  const details: any = {
    edits: [],
    executionSteps: []
  };

  let current = fileContent;

  for (let i = 0; i < edits.length; i++) {
    const { search, position = 'replace', replace = '', content = '' } = edits[i];
    const editDetails: any = {
      editIndex: i,
      search: {
        value: search,
        length: search?.length ?? 0,
        type: typeof search,
        isUndefined: search === undefined,
        isNull: search === null,
      },
      position,
    };

    details.executionSteps.push({
      step: `Edit ${i}`,
      currentContentLength: current.length,
    });

    if (!search) {
      return {
        success: false,
        error: `Edit ${i + 1}: search string must not be empty`,
        details: { ...details, failedAt: i }
      };
    }

    // ── CRITICAL: Search logic (from obsidian.ts:349-356)
    let count = 0;
    let pos = current.indexOf(search);
    const firstPos = pos;

    editDetails.searchLogic = {
      initialIndexOf: pos,
      firstPosValue: firstPos,
    };

    const matchPositions: number[] = [];
    if (pos !== -1) {
      matchPositions.push(pos);
    }

    while (pos !== -1) {
      count++;
      if (count > 1) break;
      pos = current.indexOf(search, pos + 1);
      if (pos !== -1) {
        matchPositions.push(pos);
      }
    }

    editDetails.matchingLogic = {
      countValue: count,
      allMatchPositions: matchPositions,
    };

    if (count === 0) {
      return {
        success: false,
        error: `Edit ${i + 1}: search string not found`,
        details: { ...details, failedAt: i, failedEdit: editDetails }
      };
    }

    if (count > 1) {
      return {
        success: false,
        error: `Edit ${i + 1}: search string matches more than once`,
        details: { ...details, failedAt: i, failedEdit: editDetails }
      };
    }

    // Apply edit (same as validation)
    if (position === 'before') {
      current = current.slice(0, firstPos) + content + current.slice(firstPos);
    } else if (position === 'after') {
      const afterPos = firstPos + search.length;
      current = current.slice(0, afterPos) + content + current.slice(afterPos);
    } else {
      current = current.slice(0, firstPos) + replace + current.slice(firstPos + search.length);
    }

    editDetails.resultAfterApply = {
      newContentLength: current.length,
    };

    details.edits.push(editDetails);
  }

  return {
    success: true,
    details
  };
}

// ────────────────────────────────────────────────────────────────────────────
// TEST EXECUTION
// ────────────────────────────────────────────────────────────────────────────

console.log('='.repeat(80));
console.log('OBSIDIAN PATCH FILE SEARCH MECHANISM DEBUG');
console.log('='.repeat(80));
console.log();

let passCount = 0;
let failCount = 0;
const divergences: any[] = [];

for (const scenario of testScenarios) {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`TEST: ${scenario.name}`);
  console.log(`${'─'.repeat(80)}`);

  // Run both validation and execution logic
  const validationResult = validatePatchLogic(scenario.fileContent, scenario.edits);
  const executionResult = executePatchLogic(scenario.fileContent, scenario.edits);

  // Check if they match expected result
  const validationExpected = scenario.expectedResult === 'pass' ? validationResult.success : !validationResult.success;
  const executionExpected = scenario.expectedResult === 'pass' ? executionResult.success : !executionResult.success;

  const validationCorrect = validationExpected;
  const executionCorrect = executionExpected;

  console.log(`Validation: ${validationResult.success ? 'PASS' : 'FAIL'} (Expected: ${scenario.expectedResult.toUpperCase()})`);
  console.log(`Execution:  ${executionResult.success ? 'PASS' : 'FAIL'} (Expected: ${scenario.expectedResult.toUpperCase()})`);

  if (!validationCorrect && !executionCorrect) {
    console.log('❌ BOTH FAILED AS EXPECTED');
    failCount++;
  } else if (validationCorrect && executionCorrect) {
    console.log('✓ BOTH PASSED AS EXPECTED');
    passCount++;
  } else {
    console.log('⚠️  DIVERGENCE DETECTED!');
    divergences.push({
      scenario: scenario.name,
      validationCorrect,
      executionCorrect,
      validationResult,
      executionResult,
    });
  }

  // Show errors if any
  if (!validationResult.success) {
    console.log(`  Validation error: ${validationResult.error}`);
  }
  if (!executionResult.success) {
    console.log(`  Execution error: ${executionResult.error}`);
  }

  // Show detailed analysis for failures
  if (!validationCorrect || !executionCorrect) {
    console.log('\n  DETAILED ANALYSIS:');
    if (validationResult.details?.failedEdit) {
      console.log(`    Validation failed at edit ${validationResult.details.failedAt}:`);
      console.log(`      Search: "${validationResult.details.failedEdit.search.value}"`);
      console.log(`      Search type: ${validationResult.details.failedEdit.search.type}`);
      console.log(`      Search length: ${validationResult.details.failedEdit.search.length}`);
      console.log(`      Match positions: ${validationResult.details.failedEdit.matchingLogic.allMatchPositions}`);
      console.log(`      Count: ${validationResult.details.failedEdit.matchingLogic.countValue}`);
    }
    if (executionResult.details?.failedEdit) {
      console.log(`    Execution failed at edit ${executionResult.details.failedAt}:`);
      console.log(`      Search: "${executionResult.details.failedEdit.search.value}"`);
      console.log(`      Match positions: ${executionResult.details.failedEdit.matchingLogic.allMatchPositions}`);
      console.log(`      Count: ${executionResult.details.failedEdit.matchingLogic.countValue}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ────────────────────────────────────────────────────────────────────────────

console.log(`\n\n${'='.repeat(80)}`);
console.log('SUMMARY');
console.log(`${'='.repeat(80)}`);
console.log(`Total scenarios: ${testScenarios.length}`);
console.log(`Passed as expected: ${passCount}`);
console.log(`Failed as expected: ${failCount}`);
console.log(`Divergences found: ${divergences.length}`);

if (divergences.length > 0) {
  console.log('\n⚠️  CRITICAL: Divergences detected between validation and execution!\n');
  for (const div of divergences) {
    console.log(`  - ${div.scenario}`);
    console.log(`    Validation correct: ${div.validationCorrect}`);
    console.log(`    Execution correct: ${div.executionCorrect}`);
  }
} else {
  console.log('\n✓ No divergences detected. Search logic is consistent.');
}

console.log();
