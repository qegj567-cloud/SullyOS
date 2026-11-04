import {beforeEach, expect, it} from 'vitest';
import {DB} from './db';
import {FRIEND_FEED_KEY, commentOnFriendPost, deleteFriendPost, emptyFriendFeed, friendPostsForCharacter,
    parseFriendFeed, publishFriendPost, readFriendFeed, saveFriendCircle, saveFriendFeedSettings} from './friendFeed';
import {defaultFriendFeedSettings, resolveFriendFeedSettings} from './friendFeedSettings';
import type {CharacterProfile, FullBackupData} from '../types';
import {stripBackupImages} from './backupExport';
import {friendPostImages} from './friendFeedImages';

const chars = ['friend-b', 'friend-c', 'friend-d'].map(id => ({
    id, name: id, avatar: '', description: '', systemPrompt: '', memories: [],
} as CharacterProfile));
beforeEach(async () => {
    await DB.saveAsset(FRIEND_FEED_KEY, JSON.stringify(emptyFriendFeed()));
    for (const char of chars) await DB.saveCharacter(char);
});
it('publishes image-only posts, preserves local refs through backup parsing and rejects remote upload refs', async () => {
    const circleId=await saveFriendCircle({name:'广场',description:'',memberIds:[chars[0].id]});
    const images=[{url:'blobref:b_photo',thumbnail:'blobref:b_photo'}];
    await publishFriendPost(circleId,'我','', 'photo-post',images);
    const state=await readFriendFeed();
    expect(friendPostImages(state.posts[0])).toEqual(images);
    expect(parseFriendFeed(JSON.stringify(state)).posts[0].images).toEqual(images);
    expect(friendPostImages(parseFriendFeed(JSON.stringify(stripBackupImages(state))).posts[0])).toEqual([]);
    await expect(publishFriendPost(circleId,'我','')).rejects.toThrow('添加图片');
    await expect(publishFriendPost(circleId,'我','图片',undefined,Array(10).fill(images[0]))).rejects.toThrow('9');
    await expect(publishFriendPost(circleId,'我','图片',undefined,[{url:'https://evil.test/a.png',thumbnail:'https://evil.test/a.png'}])).rejects.toThrow('本地图片');
    expect(await DB.getMessagesByCharId(chars[0].id,true)).toHaveLength(0);
});
it('keeps old feeds compatible and saves preferences without losing concurrent comments or circle-specific prompts', async () => {
    expect(resolveFriendFeedSettings(parseFriendFeed(JSON.stringify(emptyFriendFeed())).settings)).toEqual(defaultFriendFeedSettings());
    expect(resolveFriendFeedSettings({theme: 'unknown'} as any).theme).toBe('moments');
    const circleId = await saveFriendCircle({name: '客厅', description: '', memberIds: [chars[0].id], interactionPrompt: '像老朋友一样接梗'});
    const postId = await publishFriendPost(circleId, '我', '新动态');
    await Promise.all([
        saveFriendFeedSettings({...defaultFriendFeedSettings(), theme: 'journal', layout: 'compact', fontSize: 18, interactionPrompt: '少用感叹号'}),
        commentOnFriendPost(postId, '我', '补充'),
        saveFriendCircle({id: circleId, name: '新客厅', description: '', memberIds: [chars[0].id]}),
    ]);
    const state = await readFriendFeed();
    expect(state.settings).toMatchObject({theme: 'journal', layout: 'compact', fontSize: 18, interactionPrompt: '少用感叹号'});
    expect(state.posts[0].comments).toHaveLength(1);
    expect(state.circles[0].interactionPrompt).toBe('像老朋友一样接梗');
    expect(parseFriendFeed(JSON.stringify(state))).toEqual(state);
    await expect(saveFriendFeedSettings({...defaultFriendFeedSettings(), interactionPrompt: 'a'.repeat(3001)})).rejects.toThrow('3000');
    expect((await readFriendFeed()).settings?.layout).toBe('compact');
});
it('shares persisted posts/comments across readers, serializes concurrent writes and deduplicates retry IDs', async () => {
    const circleId = await saveFriendCircle({name: '客厅', description: '下班之后', memberIds: [chars[0].id, chars[1].id]});
    const postId = await publishFriendPost(circleId, '小雨', '今天做了咖啡', 'post-1');
    await Promise.all([commentOnFriendPost(postId, '小雨', '补充一', 'comment-1'), commentOnFriendPost(postId, '小雨', '补充二', 'comment-2')]);
    await publishFriendPost(circleId, '小雨', '重试不应覆盖', 'post-1');
    await commentOnFriendPost(postId, '小雨', '重复评论', 'comment-1');
    const state = await readFriendFeed();
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0].text).toBe('今天做了咖啡');
    expect(state.posts[0].comments.map(c => c.text).sort()).toEqual(['补充一', '补充二']);
    expect(friendPostsForCharacter(state, chars[2].id)).toHaveLength(0);
    expect(await DB.getMessagesByCharId(chars[0].id, true)).toHaveLength(0);
});
it('keeps publication audiences fixed, honors departures, and uses IDs instead of names', async () => {
    const circleId = await saveFriendCircle({name: '客厅', description: '', memberIds: [chars[0].id]});
    await publishFriendPost(circleId, '小雨', '之前的动态');
    await saveFriendCircle({id: circleId, name: '改名', description: '', memberIds: [chars[0].id, chars[1].id]});
    expect(friendPostsForCharacter(await readFriendFeed(), chars[1].id)).toHaveLength(0);
    await publishFriendPost(circleId, '小雨', '之后的动态');
    await saveFriendCircle({id: circleId, name: '改名', description: '', memberIds: [chars[1].id]});
    expect(friendPostsForCharacter(await readFriendFeed(), chars[1].id)).toHaveLength(1);
    expect(friendPostsForCharacter(await readFriendFeed(), chars[0].id)).toHaveLength(0);
});
it('rejects overlapping worlds and deleted members without overwriting existing state', async () => {
    await saveFriendCircle({name: '第一圈', description: '', memberIds: [chars[0].id]});
    await expect(saveFriendCircle({name: '第二圈', description: '', memberIds: [chars[0].id]})).rejects.toThrow('其他生活圈');
    await DB.deleteCharacter(chars[1].id);
    await expect(saveFriendCircle({name: '无效', description: '', memberIds: [chars[1].id]})).rejects.toThrow('仍然存在');
    expect((await readFriendFeed()).circles).toHaveLength(1);
});
it('deletes the shared post and comments, and refuses a late comment', async () => {
    const circleId = await saveFriendCircle({name: '客厅', description: '', memberIds: [chars[0].id]});
    const id = await publishFriendPost(circleId, '小雨', '测试');
    await commentOnFriendPost(id, '小雨', '评论');
    await deleteFriendPost(id);
    await expect(commentOnFriendPost(id, '小雨', '迟到')).rejects.toThrow('删除');
    expect((await readFriendFeed()).posts).toEqual([]);
});
it('round trips the text backup field through the real importer and rejects malformed data', async () => {
    const circleId = await saveFriendCircle({name: '备份圈', description: '', memberIds: [chars[0].id]});
    await publishFriendPost(circleId, '小雨', '不会丢失');
    const state = await readFriendFeed();
    await DB.saveAsset(FRIEND_FEED_KEY, JSON.stringify(emptyFriendFeed()));
    await DB.importFullData({friendFeed: state} as FullBackupData);
    expect(await readFriendFeed()).toEqual(state);
    expect(() => parseFriendFeed('{"version":1,"circles":[{}],"posts":[]}')).toThrow();
    await DB.saveAsset(FRIEND_FEED_KEY, 'broken');
    await expect(publishFriendPost(circleId, '小雨', '不能覆盖损坏数据')).rejects.toThrow();
    expect(await DB.getAsset(FRIEND_FEED_KEY)).toBe('broken');
});
