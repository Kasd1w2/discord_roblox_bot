async function handleReaction(reaction, user) {
    if (user.bot) return;
    if (reaction.partial) {
        try { await reaction.fetch(); } catch (err) { return; }
    }

    if (reaction.message.channel.name.startsWith('trade-')) {
        const ADMIN_ROLE_ID = '1542306776622309437';
        if (reaction.emoji.name === '✅') {
            await reaction.message.channel.send(`✅ **Order confirmed complete by <@${user.id}>!** Thank you for your purchase.`);
        } else if (reaction.emoji.name === '❌') {
            await reaction.message.channel.send(`❌ **ISSUE REPORTED:** <@&${ADMIN_ROLE_ID}>, <@${user.id}> reported a problem with this trade delivery! Please assist.`);
        }
    }
}

module.exports = { handleReaction };