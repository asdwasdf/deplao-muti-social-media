jest.mock('../services/database/DatabaseService', () => ({ __esModule: true, default: {} }));
jest.mock('../services/facebook/FacebookService', () => ({ __esModule: true, default: {} }));
jest.mock('../services/secure/SecureSettingsService', () => ({ secureGet: jest.fn() }));
jest.mock('uuid', () => ({ v4: jest.fn(() => 'test-uuid') }));

import {
  extractPostIdsFromWwwFeed,
  getAutoCommentCandidateLimit,
  hasReachedAutoCommentTarget,
  normalizeScannedGroupPosts,
  selectNewestGroupPosts,
} from '../services/facebook/FacebookAutoCommentService';
import { parseGraphQLResponse } from '../services/facebook/FacebookScanService';
import { isFacebookContentUnavailable } from '../services/facebook/BrowserDebugService';

describe('extractPostIdsFromWwwFeed', () => {
  it('ignores generic IDs when direct group post links exist', () => {
    const html = `
      <script>{"creation_time":1700000000,"url":"/groups/548721893889172/permalink/1104335322337295/"}</script>
      <script>{"story_fbid":"999999999999999","post_id":"888888888888888"}</script>
    `;

    expect(extractPostIdsFromWwwFeed(html, '548721893889172').map((post) => post.postId)).toEqual([
      '1104335322337295',
    ]);
  });

  it.each(['permalink', 'posts'])('extracts timestamped JSON-escaped group %s URLs', (route) => {
    const html = String.raw`{"creation_time":1700000000,"url":"https:\/\/www.facebook.com\/groups\/548721893889172\/${route}\/1104335322337295\/"}`;

    expect(extractPostIdsFromWwwFeed(html, '548721893889172')).toEqual([
      {
        postId: '1104335322337295',
        groupId: '548721893889172',
        groupName: '',
        timestamp: 1700000000000,
      },
    ]);
  });

  it('ignores post URLs belonging to another group', () => {
    const html = '<script>{"creation_time":1700000000,"url":"/groups/999999999999999/permalink/1104335322337295/"}</script>';

    expect(extractPostIdsFromWwwFeed(html, '548721893889172')).toEqual([]);
  });

  it('keeps direct group post URLs when Facebook omits nearby timestamps', () => {
    const html = `
      <script>{"creation_time":1700000000,"url":"/groups/548721893889172/permalink/1104335322337295/"}</script>
      <a href="/groups/548721893889172/permalink/2204335322337295/">Post without timestamp</a>
    `;

    expect(extractPostIdsFromWwwFeed(html, '548721893889172').map((post) => post.postId)).toEqual([
      '1104335322337295',
      '2204335322337295',
    ]);
  });

  it('keeps excluding permalink URLs inside comment subtrees', () => {
    const html = `
      <script>{"creation_time":1700000000,"url":"/groups/548721893889172/permalink/1104335322337295/"}</script>
      <div data-pagelet="CommentList"><a href="/groups/548721893889172/permalink/2204335322337295/">Comment permalink</a></div>
    `;

    expect(extractPostIdsFromWwwFeed(html, '548721893889172').map((post) => post.postId)).toEqual([
      '1104335322337295',
    ]);
  });

  it('does not treat actor and tracking IDs as posts', () => {
    const html = `
      <script>{"actorID":"100050893453853","story_fbid":"999999999999999","post_id":"888888888888888","id":"777777777777777"}</script>
    `;

    expect(extractPostIdsFromWwwFeed(html, '548721893889172')).toEqual([]);
  });
});

describe('isFacebookContentUnavailable', () => {
  it('detects Facebook group access-denied pages', () => {
    expect(isFacebookContentUnavailable('Bạn hiện không xem được nội dung này')).toBe(true);
    expect(isFacebookContentUnavailable('Group discussion feed')).toBe(false);
  });
});

describe('parseGraphQLResponse', () => {
  it('rejects GraphQL responses containing errors', () => {
    expect(parseGraphQLResponse({
      data: null,
      errors: [{ message: 'PersistedQueryNotFound' }],
    }, 'GroupFeed')).toEqual({
      data: null,
      error: 'PersistedQueryNotFound',
    });
  });
});

describe('normalizeScannedGroupPosts', () => {
  it('normalizes GraphQL seconds and filters invalid post IDs', () => {
    expect(normalizeScannedGroupPosts([
      { postId: '1104335322337295', timestamp: 1700000000 },
      { postId: '2204335322337295', timestamp: 1700000000000 },
      { postId: '', timestamp: 1700000000 },
    ], '548721893889172', 10)).toEqual([
      { postId: '1104335322337295', groupId: '548721893889172', groupName: '', timestamp: 1700000000000 },
      { postId: '2204335322337295', groupId: '548721893889172', groupName: '', timestamp: 1700000000000 },
    ]);
  });
});

describe('Auto Comment target semantics', () => {
  it('loads replacement candidates and stops only after enough successful posts', () => {
    expect(getAutoCommentCandidateLimit(15)).toBe(45);
    expect(hasReachedAutoCommentTarget(14, 15)).toBe(false);
    expect(hasReachedAutoCommentTarget(15, 15)).toBe(true);
  });
});

describe('selectNewestGroupPosts', () => {
  it('selects N newest posts total across groups', () => {
    const post = (postId: string, groupId: string, timestamp: number) => ({
      postId,
      groupId,
      groupName: `Group ${groupId}`,
      timestamp,
    });

    expect(selectNewestGroupPosts([
      post('a', '1', 1000),
      post('b', '1', 4000),
      post('c', '2', 3000),
      post('d', '2', 2000),
    ], 3).map((item) => item.postId)).toEqual(['b', 'c', 'd']);
  });
});
