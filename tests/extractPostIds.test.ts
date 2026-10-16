/**
 * Self-check for extractPostIdsFromWwwFeed — chạy bằng `npx tsx tests/extractPostIds.test.ts`
 * hoặc `node --import tsx tests/extractPostIds.test.ts`.
 *
 * Không dùng test framework: chạy assert inline, exit code != 0 nếu fail.
 * Đây là sanity check cho bug "bot comment vào reply của chính nó".
 */

import { extractPostIdsFromWwwFeed } from '../src/services/facebook/FacebookAutoCommentService';

const GID = '1234567890';
let failed = 0;
let passed = 0;
const assert = (cond: unknown, label: string) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
};

console.log('extractPostIdsFromWwwFeed tests');

// Case 1: HTML chỉ chứa permalink top-level, không có comment.
{
  const html = `
    <div role="article" data-pagelet="FeedUnit_0">
      <a href="/groups/${GID}/permalink/111111111/">Post gốc 1</a>
    </div>
    <div role="article" data-pagelet="FeedUnit_1">
      <a href="/groups/${GID}/permalink/222222222/">Post gốc 2</a>
    </div>
  `;
  const ids = extractPostIdsFromWwwFeed(html, GID).map((p) => p.postId);
  assert(JSON.stringify(ids) === '["111111111","222222222"]', `case1: chỉ top-level → [111,222], got ${JSON.stringify(ids)}`);
}

// Case 2: permalink nằm trong subtree comment (data-pagelet*Comment*) — phải bị bỏ.
{
  const html = `
    <div role="article" data-pagelet="FeedUnit_0">
      <a href="/groups/${GID}/permalink/111111111/">Post gốc</a>
      <div data-pagelet="NestedComment_0">
        <a href="/groups/${GID}/permalink/333333333/">Comment reply</a>
      </div>
      <div data-pagelet="PermalinkComment_0">
        <a href="/groups/${GID}/permalink/444444444/">Comment permalink</a>
      </div>
    </div>
  `;
  const ids = extractPostIdsFromWwwFeed(html, GID).map((p) => p.postId);
  assert(JSON.stringify(ids) === '["111111111"]', `case2: bỏ comment permalink → chỉ [111], got ${JSON.stringify(ids)}`);
}

// Case 3: aria-label "Bình luận" (tiếng Việt).
{
  const html = `
    <a href="/groups/${GID}/permalink/111111111/">Top level</a>
    <div aria-label="Bình luận của Phạm" role="article">
      <a href="/groups/${GID}/permalink/555555555/">Reply should be skipped</a>
    </div>
  `;
  const ids = extractPostIdsFromWwwFeed(html, GID).map((p) => p.postId);
  assert(JSON.stringify(ids) === '["111111111"]', `case3: aria-label "Bình luận" → bỏ reply, got ${JSON.stringify(ids)}`);
}

// Case 4: permalink nằm ngay sát (trong 600 char) data-pagelet*Comment* — bỏ.
// Nếu anchor nằm xa > 600 char thì logic không lọc (false negative) — đây là
// limitation đã biết, OK cho hầu hết trang FB vì comment subtree thường < 600 char.
{
  const html = `
    <div data-pagelet="PermalinkComment_5"><a href="/groups/${GID}/permalink/666666666/">reply trong comment</a></div>
    <a href="/groups/${GID}/permalink/777777777/">cách xa, top level</a>
  `;
  const ids = extractPostIdsFromWwwFeed(html, GID).map((p) => p.postId);
  assert(!ids.includes('666666666'), `case4: permalink trong subtree comment ngay sát → bỏ, got ${JSON.stringify(ids)}`);
  assert(ids.includes('777777777'), `case4: permalink xa, top level → giữ, got ${JSON.stringify(ids)}`);
}

// Case 5: pattern /groups/<gid>/posts/<pid>/ cũng filter comment context.
{
  const html = `
    <div role="article" data-pagelet="FeedUnit_2">
      <a href="/groups/${GID}/posts/888888888/">Top level new layout</a>
      <div data-pagelet="ReplyComment_0">
        <a href="/groups/${GID}/posts/999999999/">Reply in new layout</a>
      </div>
    </div>
  `;
  const ids = extractPostIdsFromWwwFeed(html, GID).map((p) => p.postId);
  assert(JSON.stringify(ids) === '["888888888"]', `case5: posts/<id> new layout → bỏ reply, got ${JSON.stringify(ids)}`);
}

// Case 6: dedupe — cùng id xuất hiện nhiều lần chỉ count 1.
{
  const html = `
    <a href="/groups/${GID}/permalink/111111111/">A</a>
    <a href="/groups/${GID}/permalink/111111111/">B</a>
  `;
  const ids = extractPostIdsFromWwwFeed(html, GID).map((p) => p.postId);
  assert(ids.length === 1, `case6: dedupe permalink → length 1, got ${ids.length}`);
}

// Case 7: postId = groupId bị bỏ.
{
  const html = `<a href="/groups/${GID}/permalink/${GID}/">Self ref</a>`;
  const ids = extractPostIdsFromWwwFeed(html, GID);
  assert(ids.length === 0, `case7: bỏ postId === groupId, got ${ids.length}`);
}

// Case 8: fallback pattern story_fbid.
{
  const html = `<a href="/groups/${GID}/permalink/111111111/">A</a>
                <script>{"story_fbid":222222222,"other":"x"}</script>`;
  const ids = extractPostIdsFromWwwFeed(html, GID).map((p) => p.postId);
  assert(ids.includes('111111111') && ids.includes('222222222'),
    `case8: fallback story_fbid → [111,222], got ${JSON.stringify(ids)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
