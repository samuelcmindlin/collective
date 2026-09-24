import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type TextChannel, type Webhook, type Message as DiscordMessage } from 'discord.js';
import type { Config } from './config.js';
import type { CollectiveService } from './service.js';
import type { Scheduler } from './scheduler.js';
import type { Outbox } from './types.js';
import { nowIso } from './store.js';

export function isDiscordOperator(userId: string, config: Pick<Config, 'operatorIds'>) { return config.operatorIds.includes(userId); }
export function discordScopeText(scope: Record<string, unknown>) {
  const serialized = JSON.stringify(scope, null, 2).replaceAll('`', '\\u0060');
  return serialized.length <= 900 ? serialized : undefined;
}
export class DiscordBridge {
  private client?: Client;
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private flushDone?: Promise<void>;
  private stopping = false;
  private catchingUp = false;
  private hooks = new Map<string, Webhook>();
  private requestChannel?: string;
  constructor(private service: CollectiveService, private config: Config, private scheduler: Scheduler) {}
  async connect() {
    this.stopping = false; this.hooks.clear(); this.requestChannel = undefined;
    if (this.config.mode === 'simulation') { this.timer = setInterval(() => void this.flush(), 500); this.timer.unref(); return; }
    if (!this.config.discordToken || !this.config.discordGuildId) return;
    if (!this.config.operatorIds.length) { this.scheduler.status.discord = 'error'; this.scheduler.status.discordError = 'Configure at least one Discord operator user ID before connecting.'; return; }
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], allowedMentions: { parse: [] }, rest: { timeout: 15000 } });
    this.client.on('error', error => this.fail(error));
    this.client.on('shardDisconnect', () => { this.scheduler.status.discord = 'connecting'; });
    this.client.on('shardResume', () => { void this.catchUp().then(() => { if (!this.stopping) this.scheduler.status.discord = 'connected'; }).catch(error => this.fail(error)); });
    this.client.on('messageCreate', message => { if (!this.catchingUp && !this.stopping) this.ingest(message); });
    this.client.on('interactionCreate', interaction => {
      if (!interaction.isButton() || !interaction.customId.startsWith('collective:')) return;
      void (async () => {
        if (interaction.guildId !== this.config.discordGuildId || !isDiscordOperator(interaction.user.id, this.config)) { await interaction.reply({ content: 'Only configured Collective operators can decide requests.', flags: 64 }); return; }
        const [, decision, requestId] = interaction.customId.split(':');
        if (!requestId || !['approved', 'denied'].includes(decision ?? '')) return;
        try {
          if (decision === 'approved' && !discordScopeText(this.service.store.require('requests', requestId).scope)) throw new Error('This scope is too large to review here. Open the local Requests inbox to inspect and approve it.');
          const request = this.service.decideRequest(requestId, decision as 'approved' | 'denied', 'Decided in Discord', `discord:${interaction.user.id}`);
          await interaction.update({ embeds: [this.requestEmbed(request.id)], components: [] });
        } catch (error) { await interaction.reply({ content: error instanceof Error ? error.message : 'Request could not be decided.', flags: 64 }); }
      })().catch(error => this.fail(error));
    });
    let readyTimer: NodeJS.Timeout;
    const ready = new Promise<void>((resolve, reject) => {
      readyTimer = setTimeout(() => reject(new Error('Discord connection timed out. Check the bot token, server ID, and Message Content intent.')), 20000);
      this.client!.once('clientReady', () => { clearTimeout(readyTimer); resolve(); });
    });
    void ready.catch(() => {});
    try {
      await this.client.login(this.config.discordToken); await ready; await this.provision(); await this.catchUp();
      this.scheduler.status.discord = 'connected'; this.scheduler.status.discordError = undefined;
      this.service.store.event('discord.connected', 'system', undefined);
      this.timer = setInterval(() => void this.flush(), 1200); this.timer.unref();
    } catch (error) { this.fail(error); await this.client.destroy(); }
    finally { clearTimeout(readyTimer!); }
  }
  private ingest(message: DiscordMessage) {
    if (message.guildId !== this.config.discordGuildId) return;
    const room = this.service.store.all('rooms').find(r => r.channelId === message.channelId); if (!room) return;
    if (!message.author.bot && !message.webhookId && message.content.trim()) this.service.ingestHuman(room.id, message.id, message.author.id, message.member?.displayName ?? message.author.username, message.content.slice(0, 4000), isDiscordOperator(message.author.id, this.config));
    if (!room.discordCursor || BigInt(message.id) > BigInt(room.discordCursor)) this.service.store.patch('rooms', room.id, { discordCursor: message.id });
  }
  private async catchUp() {
    if (this.catchingUp || this.stopping) return;
    this.catchingUp = true;
    try {
      for (const room of this.service.store.all('rooms')) {
        if (!room.channelId || this.stopping) continue;
        const channel = await this.client!.channels.fetch(room.channelId);
        if (!channel || channel.type !== ChannelType.GuildText) throw new Error(`Cannot read history for ${room.name}.`);
        for (let page = 0; page < 20 && !this.stopping; page++) {
          const cursor = this.service.store.require('rooms', room.id).discordCursor;
          const messages = await channel.messages.fetch({ limit: 100, ...(cursor ? { after: cursor } : {}) });
          for (const message of [...messages.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)) this.ingest(message);
          if (messages.size < 100) break;
          if (page === 19) throw new Error('Discord history backlog exceeds 2,000 messages in one room. Reconnect to continue catching up.');
        }
      }
    } finally { this.catchingUp = false; }
  }
  async provision() {
    if (!this.client || !this.config.discordGuildId) throw new Error('Discord is not connected.');
    const guild = await this.client.guilds.fetch(this.config.discordGuildId);
    const channels = await guild.channels.fetch();
    let category = channels.find(c => c?.type === ChannelType.GuildCategory && c.name === 'Collective');
    if (!category) category = await guild.channels.create({ name: 'Collective', type: ChannelType.GuildCategory, reason: 'Set up the user-requested Collective environment' });
    for (const room of this.service.store.all('rooms')) {
      const existing = room.channelId ? channels.get(room.channelId) : channels.find(c => c?.parentId === category!.id && c.type === ChannelType.GuildText && c.topic === `collective-room:${room.id}`);
      const channel = existing ?? await guild.channels.create({ name: room.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'), type: ChannelType.GuildText, parent: category.id, topic: `collective-room:${room.id}`, reason: room.purpose });
      if (channel.type !== ChannelType.GuildText) throw new Error(`Room ${room.name} is not a text channel.`);
      this.service.store.patch('rooms', room.id, { channelId: channel.id });
    }
    let requests = channels.find(c => c?.parentId === category!.id && c.type === ChannelType.GuildText && c.topic === 'collective-requests');
    if (!requests) requests = await guild.channels.create({ name: 'requests', type: ChannelType.GuildText, parent: category.id, topic: 'collective-requests', permissionOverwrites: [{ id: guild.id, deny: [PermissionFlagsBits.SendMessages] }, { id: this.client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] });
    this.requestChannel = requests.id;
    this.service.store.event('discord.provisioned', 'system', undefined, { rooms: this.service.store.all('rooms').length });
  }
  async flush() {
    if (this.stopping || this.flushing || (this.config.mode === 'live' && this.scheduler.status.discord !== 'connected')) return;
    this.flushing = true;
    let resolveDone!: () => void;
    this.flushDone = new Promise<void>(resolve => { resolveDone = resolve; });
    try {
      const items = this.service.store.all('outbox').filter(o => o.status === 'pending' && o.nextAttemptAt <= nowIso()).slice(0, 5);
      for (const item of items) {
        if (this.stopping) break;
        this.service.store.patch('outbox', item.id, { status: 'sending' });
        try {
          const discordId = this.config.mode === 'simulation' ? `simulation:${item.id}` : await this.send(item);
          if (item.kind === 'message') this.service.deliverMessage(item.entityId, discordId);
          this.service.store.patch('outbox', item.id, { status: 'sent', discordId, error: undefined });
        } catch (error) {
          const attempts = item.attempts + 1;
          this.service.store.patch('outbox', item.id, { status: attempts >= 8 ? 'failed' : 'pending', attempts, nextAttemptAt: new Date(Date.now() + Math.min(300000, 2000 * 2 ** attempts)).toISOString(), error: error instanceof Error ? error.message : String(error) });
          if (attempts >= 8) { if (item.kind === 'message') this.service.store.patch('messages', item.entityId, { delivery: 'failed' }); this.service.store.event('discord.delivery_failed', 'system', item.entityId); }
        }
      }
    } finally { this.flushing = false; resolveDone(); }
  }
  private async send(item: Outbox): Promise<string> {
    let channelId = item.roomId === 'requests' ? this.requestChannel : this.service.store.require('rooms', item.roomId).channelId;
    if (!channelId) { await this.provision(); channelId = item.roomId === 'requests' ? this.requestChannel : this.service.store.require('rooms', item.roomId).channelId; }
    const channel = await this.client!.channels.fetch(channelId!);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Discord destination is unavailable.');
    const marker = `collective:${item.id}`;
    // Reconcile a send whose acknowledgement was lost before retrying it.
    if (item.attempts > 0 || item.status === 'pending') {
      const recent = await channel.messages.fetch({ limit: 100 });
      const prior = recent.find(m => m.author.bot && m.embeds.some(e => e.footer?.text === marker));
      if (prior) return prior.id;
    }
    if (item.kind === 'request') {
      const request = this.service.store.require('requests', item.entityId);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`collective:approved:${request.id}`).setLabel('Approve once · 24h').setStyle(ButtonStyle.Success).setDisabled(!discordScopeText(request.scope)), new ButtonBuilder().setCustomId(`collective:denied:${request.id}`).setLabel('Deny').setStyle(ButtonStyle.Secondary));
      const message = await channel.send({ embeds: [this.requestEmbed(request.id).setFooter({ text: marker })], components: request.status === 'pending' ? [row] : [], allowedMentions: { parse: [] } }); return message.id;
    }
    if (item.kind === 'artifact') {
      const artifact = this.service.store.require('artifacts', item.entityId);
      const message = await channel.send({ embeds: [new EmbedBuilder().setTitle(artifact.title).setDescription(`${artifact.description.slice(0, 3500)}\n\nEvidence ID: \`${artifact.id}\`\nAvailable in the operator’s local artifact gallery.`).setColor(0xb9c798).setFooter({ text: marker })], allowedMentions: { parse: [] } }); return message.id;
    }
    const message = this.service.store.require('messages', item.entityId);
    const agent = this.service.store.get('agents', message.authorId);
    const hook = await this.webhook(channel);
    const sent = await hook.send({ username: (agent ? `${agent.name} · ${agent.role}` : message.authorName).slice(0, 80), content: message.content, embeds: [new EmbedBuilder().setColor(agent ? parseInt(agent.color.slice(1), 16) : 0xb9c798).setFooter({ text: marker })], allowedMentions: { parse: [] } }); return sent.id;
  }
  private async webhook(channel: TextChannel) {
    const cached = this.hooks.get(channel.id); if (cached) return cached;
    const hooks = await channel.fetchWebhooks();
    const hook = hooks.find(h => h.name === 'Collective agents' && h.owner?.id === this.client?.user?.id) ?? await channel.createWebhook({ name: 'Collective agents', reason: 'Room conversation for the collective' });
    this.hooks.set(channel.id, hook); return hook;
  }
  private requestEmbed(requestId: string) {
    const r = this.service.store.require('requests', requestId);
    const scope = discordScopeText(r.scope);
    return new EmbedBuilder().setTitle(r.title).setColor(r.status === 'approved' ? 0xb9c798 : 0xd8a681).setDescription(r.reason.slice(0, 2000)).addFields({ name: 'Requested by', value: this.service.store.require('agents', r.agentId).name, inline: true }, { name: 'Status', value: r.status, inline: true }, { name: 'Capability', value: r.capability }, { name: 'Exact scope', value: scope ? `\`\`\`json\n${scope}\n\`\`\`` : 'Too large to display in full. Review and approve this request in the local app.' }, { name: 'Alternative', value: r.alternatives.slice(0, 1000) }, { name: 'Estimated external cost', value: `$${r.estimatedCost.toFixed(2)}` });
  }
  private fail(error: unknown) { this.scheduler.status.discord = 'error'; this.scheduler.status.discordError = error instanceof Error ? error.message.slice(0, 500) : 'Discord connection failed'; this.service.store.event('discord.error', 'system', undefined, { error: this.scheduler.status.discordError }); }
  async stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); await this.flushDone; await this.client?.destroy(); }
}
