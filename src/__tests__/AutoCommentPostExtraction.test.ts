jest.mock('../services/database/DatabaseService', () => ({ __esModule: true, default: {} }));
jest.mock('../services/facebook/FacebookService', () => ({ __esModule: true, default: {} }));
jest.mock('../services/secure/SecureSettingsService', () => ({ secureGet: jest.fn() }));
jest.mock('uuid', () => ({ v4: jest.fn(() => 'test-uuid') }));

import {
  isManagedAutoCommentImagePath,
  validateAutoCommentImage,
  validateAutoCommentImageContent,
} from '../services/facebook/AutoCommentImage';
import {
  buildCommentAttachments,
  buildFacebookGroupFeedUrl,
  buildGroupPostVerification,
  extractPostIdsFromWwwFeed,
  getAutoCommentCandidateLimit,
  hasReachedAutoCommentTarget,
  listAttachmentPaths,
  normalizeCommentAttachments,
  normalizeScannedGroupPosts,
  recoverInterruptedAutoCommentJobs,
  selectNewestGroupPosts,
} from '../services/facebook/FacebookAutoCommentService';
import { parseGraphQLResponse } from '../services/facebook/FacebookScanService';
import {
  isFacebookContentUnavailable,
  isFacebookGroupFeedGraphQLRequest,
  mergeUniqueHtmlSnapshots,
  openFacebookTab,
} from '../services/facebook/BrowserDebugService';

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

describe('openFacebookTab', () => {
  it('opens and focuses a new page in an existing authenticated context', async () => {
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      bringToFront: jest.fn().mockResolvedValue(undefined),
      url: jest.fn(() => 'https://www.facebook.com/groups/1/permalink/2/'),
    };
    const context = { newPage: jest.fn().mockResolvedValue(page) };

    await expect(openFacebookTab(context, 'https://www.facebook.com/groups/1/permalink/2/')).resolves.toEqual({
      success: true,
      url: 'https://www.facebook.com/groups/1/permalink/2/',
    });
    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith('https://www.facebook.com/groups/1/permalink/2/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    expect(page.bringToFront).toHaveBeenCalledTimes(1);
  });
});

describe('isFacebookContentUnavailable', () => {
  it('detects Facebook group access-denied pages', () => {
    expect(isFacebookContentUnavailable('Bạn hiện không xem được nội dung này')).toBe(true);
    expect(isFacebookContentUnavailable('Group discussion feed')).toBe(false);
  });
});

describe('mergeUniqueHtmlSnapshots', () => {
  it('retains posts removed from the virtualized DOM after scrolling', () => {
    const first = '<a href="/groups/1312943449468552/posts/111/">First</a>';
    const second = '<a href="/groups/1312943449468552/posts/222/">Second</a>';

    expect(mergeUniqueHtmlSnapshots([first, second, second])).toContain(first);
    expect(mergeUniqueHtmlSnapshots([first, second, second])).toContain(second);
    expect(mergeUniqueHtmlSnapshots([first, second, second]).match(/Second/g)).toHaveLength(1);
  });
});

describe('isFacebookGroupFeedGraphQLRequest', () => {
  it('captures only group feed GraphQL responses', () => {
    expect(isFacebookGroupFeedGraphQLRequest(
      'https://www.facebook.com/api/graphql/',
      'fb_api_req_friendly_name=GroupsCometFeedRegularStoriesPaginationQuery&doc_id=123',
    )).toBe(true);
    expect(isFacebookGroupFeedGraphQLRequest(
      'https://www.facebook.com/api/graphql/',
      'fb_api_req_friendly_name=useCometUFICreateCommentMutation&doc_id=456',
    )).toBe(false);
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

describe('comment attachment payload', () => {
  it('builds Facebook photo attachments only for a valid upload ID', () => {
    expect(buildCommentAttachments()).toBeNull();
    expect(buildCommentAttachments('')).toBeNull();
    expect(buildCommentAttachments(12345)).toEqual([{ photo: { id: '12345' } }]);
    expect(buildCommentAttachments('67890')).toEqual([{ photo: { id: '67890' } }]);
  });
});

describe('auto comment image validation', () => {
  it('allows supported images up to 25 MiB and rejects other files', () => {
    expect(validateAutoCommentImage('/tmp/photo.jpg', 25 * 1024 * 1024)).toBeNull();
    expect(validateAutoCommentImage('/tmp/photo.WEBP', 1)).toBeNull();
    expect(validateAutoCommentImage('/tmp/photo.bmp', 1)).toMatch(/định dạng/i);
    expect(validateAutoCommentImage('/tmp/photo.png', 25 * 1024 * 1024 + 1)).toMatch(/25 MiB/i);
  });

  it('accepts only files inside the managed image directory', () => {
    expect(isManagedAutoCommentImagePath('/data/images/one.jpg', '/data/images')).toBe(true);
    expect(isManagedAutoCommentImagePath('/data/images-escape/one.jpg', '/data/images')).toBe(false);
    expect(isManagedAutoCommentImagePath('/tmp/one.jpg', '/data/images')).toBe(false);
  });

  it('rejects renamed non-image content', () => {
    expect(validateAutoCommentImageContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
    expect(validateAutoCommentImageContent(Buffer.from('not an image'))).toMatch(/nội dung/i);
  });
});

describe('comment attachments', () => {
  it('normalizes legacy, invalid, and oversized attachment arrays', () => {
    expect(normalizeCommentAttachments(undefined, 2)).toEqual([null, null]);
    expect(normalizeCommentAttachments('not-json', 1)).toEqual([null]);
    expect(normalizeCommentAttachments(JSON.stringify([
      { file_path: '/managed/one.jpg' },
      { file_path: '' },
      { file_path: '/managed/extra.jpg' },
    ]), 2)).toEqual([
      { file_path: '/managed/one.jpg' },
      null,
    ]);
  });

  it('trims stored paths and lists every referenced image', () => {
    expect(normalizeCommentAttachments([{ file_path: ' media/a.jpg ' }], 1)).toEqual([{ file_path: 'media/a.jpg' }]);
    expect(listAttachmentPaths(JSON.stringify([null, { file_path: 'media/a.jpg' }, { file_path: 'media/b.png' }])))
      .toEqual(['media/a.jpg', 'media/b.png']);
    expect(listAttachmentPaths('broken')).toEqual([]);
  });
});

describe('recoverInterruptedAutoCommentJobs', () => {
  it('fails pending and running jobs left by a previous app process', () => {
    const run = jest.fn();

    recoverInterruptedAutoCommentJobs({ run }, 1700000000000);

    expect(run).toHaveBeenCalledWith(
      `UPDATE fb_auto_comment_jobs
       SET status = 'failed', ended_at = ?, error = ?
       WHERE status IN ('pending', 'running')`,
      [1700000000000, 'App bị dừng khi job đang chạy; cần chạy lại.'],
    );
  });
});

describe('buildFacebookGroupFeedUrl', () => {
  it.each([
    ['relevant', 'https://www.facebook.com/groups/548721893889172/'],
    ['recent_activity', 'https://www.facebook.com/groups/548721893889172/?sorting_setting=RECENT_ACTIVITY'],
    ['new_posts', 'https://www.facebook.com/groups/548721893889172/?sorting_setting=CHRONOLOGICAL'],
  ] as const)('maps %s to its Facebook feed URL', (feedType, expected) => {
    expect(buildFacebookGroupFeedUrl('548721893889172', feedType)).toBe(expected);
  });
});

describe('buildGroupPostVerification', () => {
  it('builds verifiable Facebook URLs and preserves fetch metadata', () => {
    expect(buildGroupPostVerification({
      accountId: 'account-1',
      groupId: '548721893889172',
      fetchedAt: 1700000000000,
      feedType: 'new_posts',
      feedUrl: 'https://www.facebook.com/groups/548721893889172/?sorting_setting=CHRONOLOGICAL',
      posts: [
        {
          postId: '1104335322337295',
          groupId: '548721893889172',
          groupName: 'Group test',
          timestamp: 1699999999000,
        },
      ],
    })).toEqual({
      accountId: 'account-1',
      groupId: '548721893889172',
      fetchedAt: 1700000000000,
      feedType: 'new_posts',
      feedUrl: 'https://www.facebook.com/groups/548721893889172/?sorting_setting=CHRONOLOGICAL',
      postCount: 1,
      posts: [
        {
          postId: '1104335322337295',
          groupId: '548721893889172',
          groupName: 'Group test',
          timestamp: 1699999999000,
          url: 'https://www.facebook.com/groups/548721893889172/permalink/1104335322337295/',
        },
      ],
    });
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
