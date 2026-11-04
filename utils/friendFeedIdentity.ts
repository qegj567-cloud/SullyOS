/** Compare authored identities only. Never run this over post/comment bodies. */
export const normalizeFriendIdentityName = (name: string) => name.normalize('NFKC')
    .replace(/[\s\p{Cf}]/gu, '').replace(/^@+/, '').toLowerCase();

export const FRIEND_USER_AUTHOR_RULE = '作者身份硬约束：绝不能代替用户发帖、评论、转发或补写用户的新回复；用户的姓名、网名和账号不能用作路人身份。本人只能选择提供给你的 accountId，路人只能填写 name，不能输出 authorId、authorName、ownerId、charId 或 role 来改写作者；follow/unfollow 的 authorId 仅代表关注对象。正常提及用户姓名、引用已提供的用户原话允许，但不得把虚构的新发言伪装成用户原话。';

/** These are not model-controlled fields; follow.authorId is a target, not an author. */
export function hasFriendAuthorOverride(row: Record<string, unknown>, npc = false): boolean {
    const fields = ['authorName', 'ownerId', 'charId', 'role', ...(npc ? ['accountId'] : ['name'])];
    if (npc || !['follow', 'unfollow'].includes(String(row.kind))) fields.push('authorId');
    return fields.some(key => Object.prototype.hasOwnProperty.call(row, key));
}
