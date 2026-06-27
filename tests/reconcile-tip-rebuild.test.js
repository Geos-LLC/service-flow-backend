// Source-text scan test for the ZB reconcile tip-rebuild fix.
//
// Bug: the bulk reconcile path in fullSync wrote ZB-side tips onto
// jobs.tip_amount but never created a matching cleaner_ledger 'tip' row when
// the tip arrived after job.completed. Result: per-job payroll rows showed
// $0 tip, and totalSalary excluded the amount, while the Job Details page
// (which reads jobs.tip_amount directly) showed the correct figure —
// classic "everywhere except payroll" symptom.
//
// Fix: pre-loop select grabs sfJob.tip_amount; in-loop diff vs the proposed
// update flags the job into a tipChangedJobs Set; post-loop rebuilds the
// ledger for every flagged job using the same helper handlePaymentEvent
// uses on the webhook path.

const fs = require('fs');
const path = require('path');

const ZB_SYNC_JS = fs.readFileSync(
  path.join(__dirname, '..', 'zenbooker-sync.js'),
  'utf8'
);

// Slice the `if (entity === 'reconcile')` branch — the surrounding fullSync
// is too large to scan whole, and other branches share the same helpers.
function sliceReconcileBlock(source) {
  const start = source.indexOf("if (entity === 'reconcile')");
  if (start < 0) return '';
  // Reconcile branch ends at the next sibling branch (or at the final
  // syncProgress complete write — whichever is sooner). Use the next
  // top-level await as a generous lower bound.
  const end = source.indexOf("await supabase.from('users').update({ zenbooker_last_sync", start);
  return source.slice(start, end === -1 ? source.length : end);
}

describe('ZB reconcile — ledger rebuild also fires on tip change', () => {
  const block = sliceReconcileBlock(ZB_SYNC_JS);

  test('reconcile branch is present', () => {
    expect(block.length).toBeGreaterThan(0);
  });

  test('pre-loop SELECT on jobs includes tip_amount so prev value is known', () => {
    // The .select() that fetches sfJob inside the reconcile loop must include
    // tip_amount; otherwise we cannot diff prev vs next.
    expect(block).toMatch(
      /from\(['"]jobs['"]\)\s*\.select\(['"][^'"]*tip_amount[^'"]*['"]\)/
    );
  });

  test('a Set tracks jobs whose tip_amount changed', () => {
    // Naming can drift — accept any Set whose identifier suggests tip-change
    // tracking. The fix introduces `tipChangedJobs`.
    expect(block).toMatch(/tipChangedJobs|tipChanged\w*Jobs/);
    expect(block).toMatch(/new Set\(\)/);
  });

  test('in-loop tip diff guards the Set.add() call', () => {
    // Look for the comparison pattern: prev vs next tip + a numeric threshold,
    // followed by an .add() onto the Set. Whitespace-tolerant.
    expect(block).toMatch(/prevTip|previousTip|oldTip/);
    expect(block).toMatch(/nextTip|newTip|updatedTip/);
    expect(block).toMatch(/Math\.abs\([^)]*tip[^)]*\)\s*>=?\s*0\.0?1/i);
    expect(block).toMatch(/tipChangedJobs\.add\(/);
  });

  test('post-loop rebuild iterates the Set and calls rebuildLedger', () => {
    // The fix block must contain both the iteration and a rebuildLedger call.
    expect(block).toMatch(/for\s*\(\s*const\s+\w+\s+of\s+tipChangedJobs\s*\)/);
    expect(block).toMatch(
      /rebuildLedger\(\s*\w+\s*,\s*userId\s*,\s*\{\s*types:\s*\[\s*['"]earning['"]\s*,\s*['"]tip['"]\s*,\s*['"]incentive['"]\s*\]/
    );
  });

  test('rebuild error path marks the job dirty (not silently swallowed)', () => {
    // Mirror the existing markDirty/resolveDirty pattern used by the
    // assignment-fixed rebuild block above.
    expect(block).toMatch(/markDirty\(/);
    expect(block).toMatch(/operation:\s*['"]ledger_rebuild['"]/);
  });
});
