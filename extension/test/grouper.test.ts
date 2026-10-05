import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildPrompt, toSuggestions, enforceGroupLimit, suggest, truncateTitle, applyDomainRules,
  findDuplicates, inferTargetGroup, tokenizeTitle, titleGroupSimilarity, matchTabsToExistingGroups,
} from '../src/grouper';
import type { TabInfo, AffinityMap, DomainRule, WeightedAffinityMap, RejectionEntry } from '../src/types';
import { DEFAULT_SETTINGS, COLORS } from '../src/types';

const TEST_SETTINGS = { ...DEFAULT_SETTINGS, provider: 'openai', baseUrl: 'https://api.test.com/v1', apiKey: 'test', model: 'test-model' };

const tabs: TabInfo[] = [
  { id: 1, title: 'GitHub - repo', url: 'https://github.com/user/repo' },
  { id: 2, title: 'Stack Overflow - question', url: 'https://stackoverflow.com/q/123' },
  { id: 3, title: 'YouTube - video', url: 'https://youtube.com/watch?v=abc' },
  { id: 4, title: 'Gmail - inbox', url: 'https://mail.google.com/inbox' },
];

// ---------- truncateTitle ----------

describe('truncateTitle', () => {
  it('returns title unchanged when under limit', () => {
    expect(truncateTitle('Short', 80)).toBe('Short');
  });

  it('returns title unchanged when exactly at limit', () => {
    const t = 'x'.repeat(80);
    expect(truncateTitle(t, 80)).toBe(t);
  });

  it('truncates and adds ellipsis when over limit', () => {
    const t = 'x'.repeat(100);
    const result = truncateTitle(t, 80);
    expect(result).toHaveLength(80);
    expect(result.endsWith('\u2026')).toBe(true);
  });

  it('handles empty string', () => {
    expect(truncateTitle('', 80)).toBe('');
  });

  it('handles limit of 1', () => {
    expect(truncateTitle('hello', 1)).toBe('\u2026');
  });

  it('handles unicode titles', () => {
    const t = '日本語のタイトル';
    expect(truncateTitle(t, 5)).toHaveLength(5);
  });
});

// ---------- applyDomainRules ----------

describe('applyDomainRules', () => {
  it('returns all tabs as remaining when no rules', () => {
    const { matched, remaining } = applyDomainRules(tabs, []);
    expect(matched).toHaveLength(0);
    expect(remaining).toEqual(tabs);
  });

  it('matches exact domain', () => {
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'blue' }];
    const { matched, remaining } = applyDomainRules(tabs, rules);
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe('Dev');
    expect(matched[0].tabs).toHaveLength(1);
    expect(matched[0].tabs[0].id).toBe(1);
    expect(remaining).toHaveLength(3);
  });

  it('matches www. prefix by stripping it', () => {
    const tabsWithWww: TabInfo[] = [{ id: 10, title: 'Test', url: 'https://www.github.com/test' }];
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'blue' }];
    const { matched } = applyDomainRules(tabsWithWww, rules);
    expect(matched).toHaveLength(1);
    expect(matched[0].tabs[0].id).toBe(10);
  });

  it('matches wildcard domains for AWS multi-session hosts', () => {
    const awsTabs: TabInfo[] = [
      {
        id: 20,
        title: 'AWS Console',
        url: 'https://123456789012-a1b2c3.us-east-1.console.aws.amazon.com/ec2/home',
      },
      {
        id: 21,
        title: 'AWS Console EU',
        url: 'https://123456789012-z9y8x7.eu-west-1.console.aws.amazon.com/lambda/home',
      },
    ];
    const rules: DomainRule[] = [
      { domain: '123456789012-*.console.aws.amazon.com', groupName: 'AWS Prod', color: 'purple' },
    ];

    const { matched, remaining } = applyDomainRules(awsTabs, rules);

    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe('AWS Prod');
    expect(matched[0].tabs.map(t => t.id)).toEqual([20, 21]);
    expect(remaining).toHaveLength(0);
  });

  it('does not treat exact domains as prefix or subdomain matches', () => {
    const subdomainTabs: TabInfo[] = [{ id: 22, title: 'API', url: 'https://api.github.com/repos' }];
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'blue' }];
    const { matched, remaining } = applyDomainRules(subdomainTabs, rules);

    expect(matched).toHaveLength(0);
    expect(remaining).toEqual(subdomainTabs);
  });

  it('groups multiple tabs matching same rule', () => {
    const moreTabs: TabInfo[] = [
      { id: 10, title: 'GH 1', url: 'https://github.com/a' },
      { id: 11, title: 'GH 2', url: 'https://github.com/b' },
    ];
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'blue' }];
    const { matched } = applyDomainRules(moreTabs, rules);
    expect(matched[0].tabs).toHaveLength(2);
  });

  it('applies multiple rules independently', () => {
    const rules: DomainRule[] = [
      { domain: 'github.com', groupName: 'Dev', color: 'blue' },
      { domain: 'youtube.com', groupName: 'Media', color: 'red' },
    ];
    const { matched, remaining } = applyDomainRules(tabs, rules);
    expect(matched).toHaveLength(2);
    expect(remaining).toHaveLength(2);
  });

  it('handles tabs with invalid URLs gracefully', () => {
    const badTabs: TabInfo[] = [{ id: 99, title: 'Bad', url: 'not-a-url' }];
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'blue' }];
    const { remaining } = applyDomainRules(badTabs, rules);
    expect(remaining).toHaveLength(1);
  });

  it('leaves invalid URLs unmatched even with wildcard rules', () => {
    const badTabs: TabInfo[] = [{ id: 100, title: 'Bad', url: 'not-a-url' }];
    const rules: DomainRule[] = [{ domain: '*.com', groupName: 'Wildcard', color: 'cyan' }];
    const { matched, remaining } = applyDomainRules(badTabs, rules);

    expect(matched).toHaveLength(0);
    expect(remaining).toEqual(badTabs);
  });

  it('preserves color from domain rule', () => {
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'purple' }];
    const { matched } = applyDomainRules(tabs, rules);
    expect(matched[0].color).toBe('purple');
  });

  it('prefers exact rules over wildcard rules', () => {
    const exactTabs: TabInfo[] = [{ id: 101, title: 'Console', url: 'https://console.aws.amazon.com/home' }];
    const rules: DomainRule[] = [
      { domain: '*.aws.amazon.com', groupName: 'AWS Wildcard', color: 'pink' },
      { domain: 'console.aws.amazon.com', groupName: 'AWS Exact', color: 'green' },
    ];
    const { matched } = applyDomainRules(exactTabs, rules);

    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe('AWS Exact');
    expect(matched[0].color).toBe('green');
  });
});

// ---------- inferTargetGroup ----------

import { inferTargetGroup } from '../src/grouper';

describe('inferTargetGroup', () => {
  it('returns null for unparseable URLs', () => {
    expect(inferTargetGroup('not-a-url', [], {})).toBeNull();
  });

  it('matches rules first, then affinity', () => {
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'RulesDev', color: 'red' }];
    const affinity: import('../src/types').AffinityMap = { 'github.com': 'AffinityDev' };

    // Rules win
    expect(inferTargetGroup('https://github.com/a', rules, affinity)).toEqual({ name: 'RulesDev', color: 'red' });
  });

  it('falls back to affinity if no rule matches', () => {
    const rules: DomainRule[] = [];
    const affinity: import('../src/types').AffinityMap = { 'github.com': 'AffinityDev' };

    expect(inferTargetGroup('https://github.com/expr', rules, affinity)).toEqual({ name: 'AffinityDev' });
  });

  it('strips www. from hostname when checking rules', () => {
    const rules: DomainRule[] = [{ domain: 'youtube.com', groupName: 'Media', color: 'red' }];
    expect(inferTargetGroup('https://www.youtube.com/watch', rules, {})).toEqual({ name: 'Media', color: 'red' });
  });

  it('matches wildcard rules when inferring target groups', () => {
    const rules: DomainRule[] = [
      { domain: '123456789012-*.console.aws.amazon.com', groupName: 'AWS Prod', color: 'purple' },
    ];

    expect(inferTargetGroup(
      'https://123456789012-newsession.ap-south-1.console.aws.amazon.com/cloudwatch/home',
      rules,
      {},
    )).toEqual({ name: 'AWS Prod', color: 'purple' });
  });

  it('prefers exact rules over wildcard rules when inferring target groups', () => {
    const rules: DomainRule[] = [
      { domain: '*.aws.amazon.com', groupName: 'AWS Wildcard', color: 'pink' },
      { domain: 'console.aws.amazon.com', groupName: 'AWS Exact', color: 'green' },
    ];

    expect(inferTargetGroup('https://console.aws.amazon.com/home', rules, {})).toEqual({
      name: 'AWS Exact',
      color: 'green',
    });
  });

  it('strips www. from hostname when checking affinity', () => {
    const affinity = { 'youtube.com': 'AffinityMedia' };
    expect(inferTargetGroup('https://www.youtube.com/watch', [], affinity)).toEqual({ name: 'AffinityMedia' });
    expect(inferTargetGroup('https://not-in-affinity.com', [], affinity)).toBeNull();
  });
});

// ---------- findDuplicates ----------

describe('findDuplicates', () => {
  it('returns empty when no duplicates', () => {
    expect(findDuplicates(tabs)).toHaveLength(0);
  });

  it('finds exact URL duplicates', () => {
    const dupes: TabInfo[] = [
      { id: 1, title: 'Page', url: 'https://example.com/page' },
      { id: 2, title: 'Page Copy', url: 'https://example.com/page' },
    ];
    const result = findDuplicates(dupes);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
  });

  it('normalizes trailing slashes', () => {
    const dupes: TabInfo[] = [
      { id: 1, title: 'A', url: 'https://example.com/page/' },
      { id: 2, title: 'B', url: 'https://example.com/page' },
    ];
    const result = findDuplicates(dupes);
    expect(result).toHaveLength(1);
  });

  it('normalizes hash fragments', () => {
    const dupes: TabInfo[] = [
      { id: 1, title: 'A', url: 'https://example.com/page#section1' },
      { id: 2, title: 'B', url: 'https://example.com/page#section2' },
    ];
    const result = findDuplicates(dupes);
    expect(result).toHaveLength(1);
  });

  it('treats different query params as different', () => {
    const tabs: TabInfo[] = [
      { id: 1, title: 'A', url: 'https://example.com/page?a=1' },
      { id: 2, title: 'B', url: 'https://example.com/page?a=2' },
    ];
    expect(findDuplicates(tabs)).toHaveLength(0);
  });

  it('finds multiple duplicate groups', () => {
    const dupes: TabInfo[] = [
      { id: 1, title: 'A1', url: 'https://a.com' },
      { id: 2, title: 'A2', url: 'https://a.com' },
      { id: 3, title: 'B1', url: 'https://b.com' },
      { id: 4, title: 'B2', url: 'https://b.com' },
      { id: 5, title: 'C', url: 'https://c.com' },
    ];
    expect(findDuplicates(dupes)).toHaveLength(2);
  });

  it('handles tabs with invalid URLs', () => {
    const dupes: TabInfo[] = [
      { id: 1, title: 'A', url: 'not-url' },
      { id: 2, title: 'B', url: 'not-url' },
    ];
    const result = findDuplicates(dupes);
    expect(result).toHaveLength(1);
  });

  it('handles empty tab list', () => {
    expect(findDuplicates([])).toHaveLength(0);
  });
});

// ---------- buildPrompt ----------

describe('buildPrompt', () => {
  it('includes tab info in prompt', () => {
    const prompt = buildPrompt(tabs, 6, {});
    expect(prompt).toContain('github.com/user/repo');
    expect(prompt).toContain('GitHub - repo');
    expect(prompt).toContain('id: 1');
  });

  it('includes max groups constraint', () => {
    const prompt = buildPrompt(tabs, 3, {});
    expect(prompt).toContain('at most 3');
  });

  it('includes affinity hints when provided', () => {
    const affinity: AffinityMap = { 'github.com': 'Dev', 'youtube.com': 'Media' };
    const prompt = buildPrompt(tabs, 6, affinity);
    expect(prompt).toContain('github.com');
    expect(prompt).toContain('Dev');
    expect(prompt).toContain('User preferences');
  });

  it('excludes affinity section when empty', () => {
    const prompt = buildPrompt(tabs, 6, {});
    expect(prompt).not.toContain('User preferences');
  });

  it('leaves the response shape to the generation schema', () => {
    // The prompt used to spell out the JSON format and list the colours. Both are
    // now the native schema's job, so asserting them here would lock in a
    // contract that no longer exists.
    const prompt = buildPrompt(tabs, 6, {});
    expect(prompt).not.toContain('Return ONLY a JSON array');
    expect(prompt).not.toContain('"tabIds"');
    for (const c of COLORS) {
      expect(prompt).not.toContain(c);
    }
  });

  it('truncates long titles according to maxTitleLength', () => {
    const longTabs: TabInfo[] = [{ id: 1, title: 'x'.repeat(200), url: 'https://example.com' }];
    const prompt = buildPrompt(longTabs, 6, {}, 50);
    expect(prompt).not.toContain('x'.repeat(200));
    expect(prompt).toContain('\u2026');
  });

  it('handles single tab', () => {
    const prompt = buildPrompt([tabs[0]], 6, {});
    expect(prompt).toContain('id: 1');
    expect(prompt).not.toContain('id: 2');
  });

  it('handles large tab set (50+ tabs)', () => {
    const manyTabs = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1, title: `Tab ${i + 1}`, url: `https://site${i + 1}.com`,
    }));
    const prompt = buildPrompt(manyTabs, 6, {});
    expect(prompt).toContain('id: 1');
    expect(prompt).toContain('id: 60');
  });

  it('handles tabs with special characters in title', () => {
    const special: TabInfo[] = [{ id: 1, title: 'Tab "with" <special> & chars', url: 'https://example.com' }];
    const prompt = buildPrompt(special, 6, {});
    // Quotes are sanitized to prevent prompt injection
    expect(prompt).toContain("Tab 'with' <special> & chars");
  });
});

// ---------- toSuggestions ----------

describe('toSuggestions', () => {
  // The host constrains output with a generation schema, so these cases are about
  // validating against local state the schema cannot know: unknown tab ids,
  // colours outside the browser palette, and tabs claimed twice.

  it('maps decoded groups onto full tab records', () => {
    const result = toSuggestions(
      [{ name: 'Dev', color: 'blue', tabIds: [1, 2] }],
      tabs,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Dev');
    expect(result[0].color).toBe('blue');
    expect(result[0].tabs.map(t => t.id)).toEqual([1, 2]);
    // Enriched from the local tab list, not whatever the model echoed back.
    expect(result[0].tabs[0]).toEqual(tabs[0]);
  });

  it('keeps every valid colour in the palette', () => {
    for (const color of COLORS) {
      const result = toSuggestions([{ name: 'T', color, tabIds: [1] }], tabs);
      expect(result[0].color).toBe(color);
    }
  });

  it('falls back to grey for a colour outside the palette', () => {
    const result = toSuggestions([{ name: 'Dev', color: 'neon', tabIds: [1] }], tabs);
    expect(result[0].color).toBe('grey');
  });

  it('falls back to grey when the colour is missing', () => {
    const result = toSuggestions([{ name: 'Dev', tabIds: [1] }], tabs);
    expect(result[0].color).toBe('grey');
  });

  it('drops tab ids that were never supplied', () => {
    const result = toSuggestions([{ name: 'Dev', color: 'blue', tabIds: [1, 999, 2] }], tabs);
    expect(result[0].tabs.map(t => t.id)).toEqual([1, 2]);
  });

  it('drops a group whose tabs are all unknown', () => {
    const result = toSuggestions(
      [{ name: 'Ghost', color: 'blue', tabIds: [999] }, { name: 'Dev', color: 'red', tabIds: [1] }],
      tabs,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Dev');
  });

  it('gives a tab to only the first group claiming it', () => {
    const result = toSuggestions(
      [{ name: 'A', color: 'blue', tabIds: [1] }, { name: 'B', color: 'red', tabIds: [1, 2] }],
      tabs,
    );
    expect(result[0].tabs.map(t => t.id)).toEqual([1]);
    expect(result[1].tabs.map(t => t.id)).toEqual([2]);
  });

  it('coerces numeric strings in tabIds', () => {
    const result = toSuggestions([{ name: 'Dev', color: 'blue', tabIds: ['1', '2'] }], tabs);
    expect(result[0].tabs.map(t => t.id)).toEqual([1, 2]);
  });

  it('names an unnamed group rather than showing a blank header', () => {
    expect(toSuggestions([{ name: '', color: 'blue', tabIds: [1] }], tabs)[0].name).toBe('Unnamed');
    expect(toSuggestions([{ color: 'blue', tabIds: [1] }], tabs)[0].name).toBe('Unnamed');
    expect(toSuggestions([{ name: '   ', color: 'blue', tabIds: [1] }], tabs)[0].name).toBe('Unnamed');
  });

  it('refuses to render a non-string name', () => {
    // The generation schema declares name as a String, so this cannot happen from
    // the host. Falling back to a placeholder beats String(42) reaching the UI.
    expect(toSuggestions([{ name: 42, color: 'blue', tabIds: [1] }], tabs)[0].name).toBe('Unnamed');
  });

  it('truncates a very long name', () => {
    const result = toSuggestions([{ name: 'x'.repeat(200), color: 'blue', tabIds: [1] }], tabs);
    expect(result[0].name.length).toBeLessThanOrEqual(50);
  });

  it('tolerates a group with no tabIds field at all', () => {
    expect(toSuggestions([{ name: 'Dev', color: 'blue' }], tabs)).toHaveLength(0);
  });

  it('tolerates a group whose tabIds is not an array', () => {
    expect(toSuggestions([{ name: 'Dev', color: 'blue', tabIds: 'nope' }], tabs)).toHaveLength(0);
  });

  it('returns nothing for an empty group list', () => {
    expect(toSuggestions([], tabs)).toHaveLength(0);
  });

  it('stops at the group cap when one is given', () => {
    const result = toSuggestions(
      [
        { name: 'A', color: 'blue', tabIds: [1] },
        { name: 'B', color: 'red', tabIds: [2] },
        { name: 'C', color: 'green', tabIds: [3] },
      ],
      tabs,
      2,
    );
    expect(result.map(g => g.name)).toEqual(['A', 'B']);
  });
});

// ---------- enforceGroupLimit ----------

describe('enforceGroupLimit', () => {
  const group = (name: string, count: number) => ({
    name,
    color: 'blue' as const,
    tabs: Array.from({ length: count }, (_, i) => ({
      id: i + 1, title: `${name} ${i}`, url: `https://${name.toLowerCase()}${i}.com`,
    })),
  });

  it('leaves a list already within the limit alone', () => {
    const input = [group('Dev', 3), group('Media', 2)];
    expect(enforceGroupLimit(input, 6)).toBe(input);
  });

  it('folds the smallest groups into Other to reach the limit', () => {
    const result = enforceGroupLimit(
      [group('Dev', 9), group('Media', 8), group('News', 7), group('Shop', 1)],
      3,
    );
    expect(result).toHaveLength(3);
    // The largest survive; the smallest is absorbed.
    expect(result.map(g => g.name).slice(0, 2)).toEqual(['Dev', 'Media']);
    expect(result[2].name).toBe('Other');
  });

  it('loses no tabs when folding', () => {
    const input = [group('A', 5), group('B', 4), group('C', 3), group('D', 2)];
    const before = input.flatMap(g => g.tabs.map(t => t.id)).length;
    const after = enforceGroupLimit(input, 2).flatMap(g => g.tabs).length;
    expect(after).toBe(before);
  });

  it('never exceeds the limit', () => {
    const input = Array.from({ length: 12 }, (_, i) => group(`G${i}`, 10 - i));
    for (const limit of [1, 2, 3, 6, 11]) {
      expect(enforceGroupLimit(input, limit).length).toBeLessThanOrEqual(limit);
    }
  });

  it('does not collide with an existing Other group', () => {
    const result = enforceGroupLimit(
      [group('Dev', 9), group('Media', 8), group('Other', 1)],
      2,
    );
    const names = result.map(g => g.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not mutate its input', () => {
    const input = [group('A', 3), group('B', 2)];
    const snapshot = JSON.stringify(input);
    enforceGroupLimit(input, 1);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------- suggest ----------

describe('suggest', () => {
  beforeEach(() => {
    vi.mocked((chrome.runtime as any).sendNativeMessage).mockReset().mockImplementation(
      (_host: string, msg: any, cb: Function) => {
        if (msg?.op === 'status') cb({ ok: true, available: true });
        else cb({ ok: true, groups: [], inputTokens: 0, outputTokens: 0 });
      }
    );
  });

  /** The native host is the only model transport; stub its decoded reply. */
  function mockLLM(groups: unknown[]) {
    vi.mocked((chrome.runtime as any).sendNativeMessage).mockImplementation(
      (_host: string, msg: any, cb: Function) => {
        if (msg?.op === 'status') cb({ ok: true, available: true });
        else cb({ ok: true, groups, inputTokens: 10, outputTokens: 5 });
      }
    );
  }

  /** The request the grouper sent to the host. */
  function lastPrompt(): { systemPrompt: string; prompt: string } {
    return vi.mocked((chrome.runtime as any).sendNativeMessage).mock.calls.at(-1)![1];
  }

  it('returns enriched suggestions from LLM', async () => {
    mockLLM([{"name": "Dev", "color": "blue", "tabIds": [1, 2]}, {"name": "Media", "color": "red", "tabIds": [3]}]);
    const { suggestions: result } = await suggest(tabs, TEST_SETTINGS, {});
    expect(result).toHaveLength(3); // 2 LLM groups + "Other" for unassigned tab 4
    expect(result[0].tabs[0].title).toBe('GitHub - repo');
    expect(result[2].name).toBe('Other');
  });

  it('passes affinity to prompt', async () => {
    mockLLM([{"name": "Dev", "color": "blue", "tabIds": [1]}]);
    await suggest(tabs, TEST_SETTINGS, { 'github.com': 'Code' });
    expect(lastPrompt().prompt).toContain('Code');
  });

  it('applies domain rules before LLM call', async () => {
    mockLLM([{"name": "Other", "color": "green", "tabIds": [2, 4]}]);
    const rules: DomainRule[] = [
      { domain: 'github.com', groupName: 'Dev', color: 'blue' },
      { domain: 'youtube.com', groupName: 'Media', color: 'red' },
    ];
    const { suggestions: result } = await suggest(tabs, TEST_SETTINGS, {}, rules);
    // 2 from rules + 1 from LLM (only remaining tabs sent)
    const devGroup = result.find(g => g.name === 'Dev');
    expect(devGroup).toBeDefined();
    expect(devGroup!.tabs[0].id).toBe(1);
  });

  it('applies wildcard domain rules before LLM call', async () => {
    mockLLM([{"name": "Other", "color": "green", "tabIds": [2]}]);
    const awsTabs: TabInfo[] = [
      {
        id: 30,
        title: 'AWS Console',
        url: 'https://123456789012-a1b2c3.us-east-1.console.aws.amazon.com/ec2/home',
      },
      { id: 31, title: 'Stack Overflow', url: 'https://stackoverflow.com/q/123' },
    ];
    const rules: DomainRule[] = [
      { domain: '123456789012-*.console.aws.amazon.com', groupName: 'AWS Prod', color: 'purple' },
    ];

    const { suggestions: result } = await suggest(awsTabs, TEST_SETTINGS, {}, rules);

    const awsGroup = result.find(g => g.name === 'AWS Prod');
    expect(awsGroup).toBeDefined();
    expect(awsGroup!.tabs.map(t => t.id)).toEqual([30]);
    expect(lastPrompt().prompt).not.toContain('AWS Console');
  });

  it('skips LLM when all tabs matched by rules', async () => {
    const allRules: DomainRule[] = [
      { domain: 'github.com', groupName: 'Dev', color: 'blue' },
      { domain: 'stackoverflow.com', groupName: 'Dev', color: 'blue' },
      { domain: 'youtube.com', groupName: 'Media', color: 'red' },
      { domain: 'mail.google.com', groupName: 'Email', color: 'green' },
    ];
    const { suggestions: result } = await suggest(tabs, TEST_SETTINGS, {}, allRules);
    expect((chrome.runtime as any).sendNativeMessage).not.toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
  });

  it('reduces maxGroups for LLM based on rule matches', async () => {
    mockLLM([{"name": "Other", "color": "green", "tabIds": [2, 4]}]);
    const rules: DomainRule[] = [{ domain: 'github.com', groupName: 'Dev', color: 'blue' }];
    await suggest(tabs, { ...TEST_SETTINGS, maxGroups: 4 }, {}, rules);
    expect(lastPrompt().prompt).toContain('at most 3');
  });

  it('throws when the host reports a failure', async () => {
    vi.mocked((chrome.runtime as any).sendNativeMessage).mockImplementation(
      (_host: string, msg: any, cb: Function) => {
        if (msg?.op === 'status') cb({ ok: true, available: true });
        else cb({ ok: false, error: 'timed out' });
      }
    );
    let caught: Error | null = null;
    try { await suggest(tabs, TEST_SETTINGS, {}); } catch (e) { caught = e as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('timed out');
  });

  it('uses system message for the model', async () => {
    mockLLM([{"name": "Dev", "color": "blue", "tabIds": [1]}]);
    await suggest(tabs, TEST_SETTINGS, {});
    expect(lastPrompt().systemPrompt).toContain('tab organizer');
  });

  // ---------- chunking ----------

  describe('more tabs than one chunk holds', () => {
    /** CHUNK_SIZE is 20, so this is six full chunks plus a remainder. */
    const manyTabs: TabInfo[] = Array.from({ length: 130 }, (_, i) => ({
      id: i + 1,
      title: `Tab ${i + 1}`,
      url: `https://site${i + 1}.example.com`,
    }));

    /** Replies with one group per call, named after the first tab in that chunk. */
    function mockChunked() {
      let call = 0;
      vi.mocked((chrome.runtime as any).sendNativeMessage).mockImplementation(
        (_host: string, msg: any, cb: Function) => {
          if (msg?.op === 'status') return cb({ ok: true, available: true });
          const ids = manyTabs
            .filter(t => msg.prompt.includes(`id: ${t.id} |`))
            .map(t => t.id);
          call++;
          cb({
            ok: true,
            groups: [{ name: `Chunk${call}`, color: 'blue', tabIds: ids }],
            inputTokens: 100,
            outputTokens: 20,
          });
        }
      );
    }

    function chunkSizes(): number[] {
      return vi.mocked((chrome.runtime as any).sendNativeMessage).mock.calls
        .filter(c => c[1]?.op === 'group')
        .map(c => (c[1].prompt.match(/id: \d+ \|/g) || []).length);
    }

    it('splits into chunks of at most 60', async () => {
      mockChunked();
      await suggest(manyTabs, { ...TEST_SETTINGS, maxGroups: 6 }, {});
      expect(chunkSizes()).toEqual([20, 20, 20, 20, 20, 20, 10]);
    });

    it('makes one host call per chunk', async () => {
      mockChunked();
      await suggest(manyTabs, TEST_SETTINGS, {});
      const groupCalls = vi.mocked((chrome.runtime as any).sendNativeMessage).mock.calls
        .filter(c => c[1]?.op === 'group');
      expect(groupCalls).toHaveLength(7);
    });

    it('assigns every tab exactly once across chunks', async () => {
      mockChunked();
      const { suggestions } = await suggest(manyTabs, TEST_SETTINGS, {});
      const ids = suggestions.flatMap(g => g.tabs.map(t => t.id));
      expect(new Set(ids).size).toBe(manyTabs.length);
    });

    it('accumulates token usage across chunks', async () => {
      mockChunked();
      const { inputTokens, outputTokens } = await suggest(manyTabs, TEST_SETTINGS, {});
      expect(inputTokens).toBe(700);
      expect(outputTokens).toBe(140);
    });

    it('honours the group limit even when chunks disagree', async () => {
      // Chunks are grouped independently, so each invents its own names. Merging
      // on name alone used to yield one group per chunk, past the user's cap.
      let call = 0;
      vi.mocked((chrome.runtime as any).sendNativeMessage).mockImplementation(
        (_host: string, msg: any, cb: Function) => {
          if (msg?.op === 'status') return cb({ ok: true, available: true });
          const ids = manyTabs.filter(t => msg.prompt.includes(`id: ${t.id} |`)).map(t => t.id);
          call++;
          cb({
            ok: true,
            groups: [
              { name: `Ideas${call}`, color: 'blue', tabIds: ids },
              { name: `Extra${call}`, color: 'red', tabIds: ids.slice(0, 5) },
            ],
            inputTokens: 10, outputTokens: 5,
          });
        }
      );

      const { suggestions } = await suggest(manyTabs, { ...TEST_SETTINGS, maxGroups: 4 }, {});
      // Four groups or fewer: the limit is the user's, not the model's.
      expect(suggestions.length).toBeLessThanOrEqual(4);
    });

    it('does not fold when the tab count fits one chunk', async () => {
      mockChunked();
      await suggest(manyTabs.slice(0, 20), TEST_SETTINGS, {});
      expect(chunkSizes()).toEqual([20]);
    });
  });
});

// ---------- inferTargetGroup (enhanced) ----------

describe('inferTargetGroup with weighted affinity', () => {
  const rules: DomainRule[] = [{ domain: 'pinned.com', groupName: 'Pinned', color: 'red' }];

  it('domain rules take highest priority', () => {
    const weighted: WeightedAffinityMap = {
      'pinned.com': { groups: { 'Other': { count: 100, lastUsed: Date.now() } } },
    };
    const result = inferTargetGroup('https://pinned.com/page', rules, {}, weighted);
    expect(result?.name).toBe('Pinned');
  });

  it('uses path-level weighted affinity', () => {
    const weighted: WeightedAffinityMap = {
      'github.com/myorg': { groups: { 'MyOrg Dev': { count: 5, lastUsed: Date.now() } } },
      'github.com': { groups: { 'Dev': { count: 10, lastUsed: Date.now() } } },
    };
    const result = inferTargetGroup('https://github.com/myorg/repo', [], {}, weighted);
    expect(result?.name).toBe('MyOrg Dev');
  });

  it('falls back to domain-level weighted affinity', () => {
    const weighted: WeightedAffinityMap = {
      'github.com': { groups: { 'Dev': { count: 5, lastUsed: Date.now() } } },
    };
    const result = inferTargetGroup('https://github.com/anything', [], {}, weighted);
    expect(result?.name).toBe('Dev');
  });

  it('skips rejected groups', () => {
    const now = Date.now();
    const weighted: WeightedAffinityMap = {
      'news.com': { groups: {
        'Dev': { count: 10, lastUsed: now },
        'News': { count: 5, lastUsed: now },
      } },
    };
    const rejections: RejectionEntry[] = [
      { timestamp: now, domain: 'news.com', rejectedGroup: 'Dev' },
    ];
    const result = inferTargetGroup('https://news.com/article', [], {}, weighted, rejections);
    expect(result?.name).toBe('News');
  });

  it('falls back to flat affinity', () => {
    const result = inferTargetGroup('https://example.com', [], { 'example.com': 'Work' });
    expect(result?.name).toBe('Work');
  });
});

// ---------- tokenizeTitle ----------

describe('tokenizeTitle', () => {
  it('tokenizes basic title', () => {
    expect(tokenizeTitle('GitHub - My Project')).toEqual(['github', 'project']);
  });

  it('filters short words', () => {
    expect(tokenizeTitle('a to the dev')).toEqual(['the', 'dev']);
  });

  it('handles empty string', () => {
    expect(tokenizeTitle('')).toEqual([]);
  });
});

// ---------- titleGroupSimilarity ----------

describe('titleGroupSimilarity', () => {
  it('returns 0 for no overlap', () => {
    expect(titleGroupSimilarity('GitHub Repository', 'Shopping Cart')).toBe(0);
  });

  it('returns positive for overlap', () => {
    expect(titleGroupSimilarity('React Development Tutorial', 'Development')).toBeGreaterThan(0);
  });

  it('returns 0 for empty inputs', () => {
    expect(titleGroupSimilarity('', 'Dev')).toBe(0);
  });
});

// ---------- matchTabsToExistingGroups ----------

describe('matchTabsToExistingGroups', () => {
  it('matches tabs to groups by title similarity', () => {
    const testTabs: TabInfo[] = [
      { id: 1, title: 'React Development Guide', url: 'https://react.dev' },
      { id: 2, title: 'Amazon Shopping Cart', url: 'https://amazon.com' },
    ];
    const { matched, remaining } = matchTabsToExistingGroups(testTabs, ['Development', 'Shopping']);
    expect(matched.get('Development')?.length).toBe(1);
    expect(matched.get('Shopping')?.length).toBe(1);
    expect(remaining).toHaveLength(0);
  });

  it('puts unmatched tabs in remaining', () => {
    const testTabs: TabInfo[] = [
      { id: 1, title: 'Random Page', url: 'https://example.com' },
    ];
    const { matched, remaining } = matchTabsToExistingGroups(testTabs, ['Development']);
    expect(matched.size).toBe(0);
    expect(remaining).toHaveLength(1);
  });
});

// ---------- buildPrompt with extra hints ----------

describe('buildPrompt with extra hints', () => {
  it('includes correction hints', () => {
    const prompt = buildPrompt(tabs, 5, {}, 80, '', {
      corrections: '\nUser corrections:\n  corrected: x.com from "A" to "B"\n',
    });
    expect(prompt).toContain('User corrections');
    expect(prompt).toContain('corrected: x.com');
  });

  it('includes rejection hints', () => {
    const prompt = buildPrompt(tabs, 5, {}, 80, '', {
      rejections: '\nAVOID: news.com should NOT be in "Dev"\n',
    });
    expect(prompt).toContain('AVOID');
  });

  it('includes weighted affinity hint', () => {
    const prompt = buildPrompt(tabs, 5, {}, 80, '', {
      affinityHint: '\nUser preferences:\n  github.com → "Dev" (12x, recent)\n',
    });
    expect(prompt).toContain('12x');
    expect(prompt).toContain('recent');
  });

  it('includes co-occurrence hints', () => {
    const prompt = buildPrompt(tabs, 5, {}, 80, '', {
      coOccurrence: '\nCo-occurrence:\n  [github.com, stackoverflow.com]\n',
    });
    expect(prompt).toContain('Co-occurrence');
  });
});
