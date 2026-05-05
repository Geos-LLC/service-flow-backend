'use strict';

const {
  computeCompanyUpdate,
  computeNameUpdate,
  classifyConversationSyncStatus,
} = require('../lib/op-conversation-update');

describe('computeCompanyUpdate — value present | null | absent semantics', () => {
  test('absent provider.company AND absent legacy company → no update (preserve SF value)', () => {
    const sigcoreConv = { participantPhone: '+15551231234' /* no provider, no company */ };
    const found = { company: 'Existing' };
    expect(computeCompanyUpdate(sigcoreConv, found)).toEqual({ shouldUpdate: false, value: null });
  });

  test('provider.company = "Thumbtack Tampa" → set company', () => {
    const sigcoreConv = { provider: { company: 'Thumbtack Tampa' } };
    const found = { company: null };
    expect(computeCompanyUpdate(sigcoreConv, found)).toEqual({ shouldUpdate: true, value: 'Thumbtack Tampa' });
  });

  test('provider.company = "" → clears SF company (Pam Zimmerman case)', () => {
    const sigcoreConv = { provider: { company: '' } };
    const found = { company: 'Site' };
    expect(computeCompanyUpdate(sigcoreConv, found)).toEqual({ shouldUpdate: true, value: null });
  });

  test('provider.company = null → clears SF company', () => {
    const sigcoreConv = { provider: { company: null } };
    const found = { company: 'Site' };
    expect(computeCompanyUpdate(sigcoreConv, found)).toEqual({ shouldUpdate: true, value: null });
  });

  test('provider.company missing key but legacy conv.company present → use legacy', () => {
    const sigcoreConv = { provider: { contactId: 'X' }, company: 'Yelp Jacksonville' };
    const found = { company: null };
    expect(computeCompanyUpdate(sigcoreConv, found)).toEqual({ shouldUpdate: true, value: 'Yelp Jacksonville' });
  });

  test('provider.company present + legacy company present → provider wins', () => {
    const sigcoreConv = { provider: { company: 'Thumbtack Tampa' }, company: 'StaleLegacy' };
    const found = { company: null };
    expect(computeCompanyUpdate(sigcoreConv, found)).toEqual({ shouldUpdate: true, value: 'Thumbtack Tampa' });
  });

  test('value unchanged → shouldUpdate=false (no churn)', () => {
    const sigcoreConv = { provider: { company: 'Thumbtack Tampa' } };
    const found = { company: 'Thumbtack Tampa' };
    expect(computeCompanyUpdate(sigcoreConv, found).shouldUpdate).toBe(false);
  });

  test('legacy conv.company = null when provider absent → clears (legacy explicit-clear path)', () => {
    const sigcoreConv = { company: null };
    const found = { company: 'Old' };
    expect(computeCompanyUpdate(sigcoreConv, found)).toEqual({ shouldUpdate: true, value: null });
  });
});

describe('computeNameUpdate — set / clear / leave-alone', () => {
  test('provider.displayName = "Pam Zimmerman" → set participant_name', () => {
    const sigcoreConv = { provider: { displayName: 'Pam Zimmerman', contactId: 'C', company: 'Site' } };
    const found = { participant_name: null };
    expect(computeNameUpdate(sigcoreConv, found)).toEqual({
      shouldUpdate: true, value: 'Pam Zimmerman', reason: 'set_from_sigcore',
    });
  });

  test('contact deleted in OP (all provider fields null + no fallbacks) → clear participant_name (Yellow Pages case)', () => {
    const sigcoreConv = { provider: { displayName: null, contactId: null, company: null } };
    const found = { participant_name: 'Yellow Pages' };
    expect(computeNameUpdate(sigcoreConv, found)).toEqual({
      shouldUpdate: true, value: null, reason: 'op_contact_deleted',
    });
  });

  test('contact deleted but conversationName fallback present → keep the conversationName', () => {
    const sigcoreConv = {
      provider: { displayName: null, contactId: null, company: null },
      conversationName: 'Group Thread',
    };
    const found = { participant_name: 'Yellow Pages' };
    expect(computeNameUpdate(sigcoreConv, found)).toEqual({
      shouldUpdate: true, value: 'Group Thread', reason: 'set_from_sigcore',
    });
  });

  test('no provider block at all → leave participant_name alone (no signal)', () => {
    const sigcoreConv = { participantPhone: '+15551234567' /* no provider, no name fields */ };
    const found = { participant_name: 'Existing' };
    expect(computeNameUpdate(sigcoreConv, found)).toEqual({
      shouldUpdate: false, value: null, reason: 'no_signal',
    });
  });

  test('provider has populated company but null displayName → keep existing name (partial signal)', () => {
    // Operator may have just cleared name — but lack of "fully empty" snapshot means we can't be sure
    const sigcoreConv = { provider: { displayName: null, contactId: 'X', company: 'Thumbtack' } };
    const found = { participant_name: 'Existing' };
    expect(computeNameUpdate(sigcoreConv, found)).toEqual({
      shouldUpdate: false, value: null, reason: 'no_signal',
    });
  });

  test('cross-reference fallback applies when provider/conv have no name', () => {
    const sigcoreConv = { provider: { contactId: 'X', displayName: null, company: 'Thumbtack' } };
    const found = { participant_name: null };
    expect(computeNameUpdate(sigcoreConv, found, 'Cross-Ref Name')).toEqual({
      shouldUpdate: true, value: 'Cross-Ref Name', reason: 'set_from_sigcore',
    });
  });

  test('value unchanged → shouldUpdate=false', () => {
    const sigcoreConv = { provider: { displayName: 'Pam Zimmerman', contactId: 'C', company: 'Site' } };
    const found = { participant_name: 'Pam Zimmerman' };
    expect(computeNameUpdate(sigcoreConv, found)).toEqual({
      shouldUpdate: false, value: 'Pam Zimmerman', reason: 'unchanged',
    });
  });

  test('firstName + lastName fallback when provider.displayName missing', () => {
    const sigcoreConv = { provider: { contactId: 'X', displayName: null, company: 'Thumbtack' }, firstName: 'Jane', lastName: 'Doe' };
    const found = { participant_name: null };
    expect(computeNameUpdate(sigcoreConv, found)).toEqual({
      shouldUpdate: true, value: 'Jane Doe', reason: 'set_from_sigcore',
    });
  });

  test('OP contact deleted + conversationName="Yellow Pages" fallback → still clear (aggregator noise)', () => {
    // Real bug: prod identity 1841 / phone +18773920112. Sigcore returned
    // provider all-null but conversationName lingered as "Yellow Pages",
    // which would have caused us to write "Yellow Pages" back.
    const sigcoreConv = {
      provider: { displayName: null, contactId: null, company: null },
      conversationName: 'Yellow Pages',
    };
    const found = { participant_name: 'Yellow Pages' };
    expect(computeNameUpdate(sigcoreConv, found)).toEqual({
      shouldUpdate: true, value: null, reason: 'op_contact_deleted',
    });
  });

  test('OP contact deleted + crossRef "Thumbtack" fallback → clear (aggregator noise)', () => {
    const sigcoreConv = { provider: { displayName: null, contactId: null, company: null } };
    const found = { participant_name: 'Thumbtack' };
    expect(computeNameUpdate(sigcoreConv, found, 'Thumbtack')).toEqual({
      shouldUpdate: true, value: null, reason: 'op_contact_deleted',
    });
  });

  test('aggregator firstName+lastName ("Yellow Pages") with no provider signal → leave alone', () => {
    // No providerBlock → can't confirm contact deleted. Aggregator name should
    // not be written either, so we end up at "no_signal".
    const sigcoreConv = { firstName: 'Yellow', lastName: 'Pages' };
    const found = { participant_name: 'Yellow Pages' };
    expect(computeNameUpdate(sigcoreConv, found)).toEqual({
      shouldUpdate: false, value: null, reason: 'no_signal',
    });
  });

  test('provider.displayName="Thumbtack S" wins even when aggregator-like (operator intent)', () => {
    // Provider block displayName is operator authoritative — if they tagged
    // the OP contact "Thumbtack S", honor that, don't filter it out.
    const sigcoreConv = { provider: { displayName: 'Thumbtack S', contactId: 'X', company: 'Thumbtack' } };
    const found = { participant_name: null };
    expect(computeNameUpdate(sigcoreConv, found)).toEqual({
      shouldUpdate: true, value: 'Thumbtack S', reason: 'set_from_sigcore',
    });
  });

  test('real person wins over aggregator fallback', () => {
    const sigcoreConv = {
      provider: { displayName: null, contactId: 'X', company: 'Yelp' },
      contactName: 'Jane Smith',
      conversationName: 'Yelp',
    };
    const found = { participant_name: null };
    expect(computeNameUpdate(sigcoreConv, found)).toEqual({
      shouldUpdate: true, value: 'Jane Smith', reason: 'set_from_sigcore',
    });
  });
});

describe('classifyConversationSyncStatus', () => {
  test('no provider block → op_unresolved (phone never matched to OP contact)', () => {
    expect(classifyConversationSyncStatus({ participantPhone: '+15551234567' })).toBe('op_unresolved');
  });

  test('provider with all fields null → op_deleted', () => {
    expect(classifyConversationSyncStatus({ provider: { contactId: null, displayName: null, company: null } }))
      .toBe('op_deleted');
  });

  test('provider with name + contact id but no company → op_company_cleared', () => {
    expect(classifyConversationSyncStatus({ provider: { contactId: 'X', displayName: 'Pam Zimmerman', company: null } }))
      .toBe('op_company_cleared');
  });

  test('provider with all fields populated → op_active', () => {
    expect(classifyConversationSyncStatus({ provider: { contactId: 'X', displayName: 'Pam Zimmerman', company: 'Site' } }))
      .toBe('op_active');
  });

  test('empty-string company treated like null (Pam-cleared case) → op_company_cleared', () => {
    expect(classifyConversationSyncStatus({ provider: { contactId: 'X', displayName: 'Pam Zimmerman', company: '' } }))
      .toBe('op_company_cleared');
  });
});
