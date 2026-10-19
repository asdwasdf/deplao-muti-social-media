export function buildFacebookGroupPostUrl(groupId: string, postId: string): string {
  return `https://www.facebook.com/groups/${encodeURIComponent(groupId)}/permalink/${encodeURIComponent(postId)}/`;
}
