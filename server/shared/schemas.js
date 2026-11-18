'use strict';

const { z } = require('zod');
const { validateHostFor, validateChannelUrl } = require('./hosts');

const boolish = z.union([z.boolean(), z.number().int().min(0).max(1)]);

const GroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  sort_order: z.number().int().default(0),
  is_public: boolish.default(1), // 0 = hidden from the public dashboard and API
});

const PROBE_TYPES = ['icmp', 'icmp6', 'dns', 'tcp', 'http'];

const TargetSchema = z.object({
  group_id: z.number().int().positive(),
  name: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(255),
  probe_type: z.enum(PROBE_TYPES),
  interval_seconds: z.number().int().min(5).max(3600).default(60),
  packet_count: z.number().int().min(1).max(100).default(10),
  enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).default(1),
  notes: z.string().max(500).optional().nullable(),
  is_public: boolish.default(1),
}).superRefine((t, ctx) => {
  // The host is validated per probe type so it can never be parsed as a command-line
  // option by ping/traceroute, and tcp/http targets must be well-formed
  const problem = validateHostFor(t.probe_type, t.host);
  if (problem) ctx.addIssue({ code: 'custom', path: ['host'], message: problem });
});

const LoginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

const PasswordField = z.string().min(10, 'Password must be at least 10 characters').max(200);

const CreateUserSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: PasswordField,
}).refine((d) => d.password.toLowerCase() !== d.username.toLowerCase(), {
  message: 'Password must not be the same as the username',
  path: ['password'],
});

// Admin resetting someone else's password
const ChangePasswordSchema = z.object({
  password: PasswordField,
});

// Self-service: must prove knowledge of the current password
const SelfPasswordSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: PasswordField,
});

const TwoFactorLoginSchema = z.object({
  challenge: z.string().min(1).max(200),
  code: z.string().min(1).max(32),
});

const PasswordAndCodeSchema = z.object({
  password: z.string().min(1).max(200),
  code: z.string().min(1).max(32),
});

const SettingsSchema = z.object({
  retention_raw_days: z.number().int().min(1).max(365).optional(),
  retention_5min_days: z.number().int().min(1).max(730).optional(),
  retention_1hour_days: z.number().int().min(1).max(3650).optional(),
  default_probe_interval: z.number().int().min(5).max(3600).optional(),
  default_packet_count: z.number().int().min(1).max(100).optional(),
  alert_after_failures: z.number().int().min(1).max(20).optional(),
  recover_after_successes: z.number().int().min(1).max(20).optional(),
  renotify_minutes: z.number().int().min(0).max(10080).optional(),
  traceroute_method: z.enum(['auto', 'icmp', 'tcp', 'udp']).optional(),
  route_confirm_runs: z.number().int().min(1).max(5).optional(),
  notify_route_changes: z.boolean().optional(),
  banner_enabled: z.boolean().optional(),
  banner_text: z.string().max(500).optional().nullable(),
  banner_type: z.enum(['info', 'warning', 'maintenance']).optional(),
  public_base_url: z.string().url().max(255).optional().nullable(),
});

const CHANNEL_TYPES = ['webhook', 'slack', 'discord', 'teams', 'ntfy', 'gotify', 'pushover', 'pagerduty', 'opsgenie', 'telegram'];

const NotificationChannelSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(CHANNEL_TYPES),
  url: z.string().trim().min(1).max(1000),
  enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).default(1),
  // Limit a channel to some groups (e.g. page only for core infrastructure). null/empty = all groups.
  group_ids: z.array(z.number().int().positive()).max(500).nullable().optional(),
  send_recovery: z.union([z.boolean(), z.number().int().min(0).max(1)]).default(1),
}).superRefine((c, ctx) => {
  const problem = validateChannelUrl(c.type, c.url);
  if (problem) ctx.addIssue({ code: 'custom', path: ['url'], message: problem });
});

const MaintenanceWindowSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(['all', 'group', 'target']).default('all'),
  scope_id: z.number().int().positive().nullable().optional(),
  starts_at: z.number().int().positive(),
  ends_at: z.number().int().positive(),
  repeat: z.enum(['none', 'daily', 'weekly']).default('none'),
}).superRefine((w, ctx) => {
  if (w.ends_at <= w.starts_at) ctx.addIssue({ code: 'custom', path: ['ends_at'], message: 'End must be after start' });
  if (w.scope !== 'all' && !w.scope_id) ctx.addIssue({ code: 'custom', path: ['scope_id'], message: 'Choose a group or target' });
  const period = w.repeat === 'daily' ? 86400 : w.repeat === 'weekly' ? 604800 : null;
  if (period && w.ends_at - w.starts_at > period) ctx.addIssue({ code: 'custom', path: ['ends_at'], message: `A ${w.repeat} window can't be longer than ${w.repeat === 'daily' ? '24 hours' : '7 days'}` });
});

const AckSchema = z.object({ note: z.string().trim().max(500).optional().nullable() });

const ResultsRangeSchema = z.enum(['1h', '6h', '12h', '24h', '7d', '30d', '3mo']);

const OrderSchema = z.object({
  sort_order: z.number().int().min(0),
});

const EnabledSchema = z.object({
  enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]),
});

module.exports = {
  GroupSchema,
  TargetSchema,
  LoginSchema,
  CreateUserSchema,
  ChangePasswordSchema,
  SelfPasswordSchema,
  TwoFactorLoginSchema,
  PasswordAndCodeSchema,
  SettingsSchema,
  NotificationChannelSchema,
  MaintenanceWindowSchema,
  AckSchema,
  PROBE_TYPES,
  CHANNEL_TYPES,
  ResultsRangeSchema,
  OrderSchema,
  EnabledSchema,
};
