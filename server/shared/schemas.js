'use strict';

const { z } = require('zod');

const GroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  sort_order: z.number().int().default(0),
});

const TargetSchema = z.object({
  group_id: z.number().int().positive(),
  name: z.string().min(1).max(100),
  host: z.string().min(1).max(255),
  probe_type: z.enum(['icmp', 'icmp6', 'dns']),
  interval_seconds: z.number().int().min(5).max(3600).default(60),
  packet_count: z.number().int().min(1).max(100).default(10),
  enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).default(1),
  notes: z.string().max(500).optional().nullable(),
});

const LoginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

const CreateUserSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
});

const ChangePasswordSchema = z.object({
  password: z.string().min(8).max(200),
});

const SettingsSchema = z.object({
  retention_raw_days: z.number().int().min(1).max(365).optional(),
  retention_5min_days: z.number().int().min(1).max(730).optional(),
  retention_1hour_days: z.number().int().min(1).max(3650).optional(),
  default_probe_interval: z.number().int().min(5).max(3600).optional(),
  default_packet_count: z.number().int().min(1).max(100).optional(),
  banner_enabled: z.boolean().optional(),
  banner_text: z.string().max(500).optional().nullable(),
  banner_type: z.enum(['info', 'warning', 'maintenance']).optional(),
  public_base_url: z.string().url().max(255).optional().nullable(),
});

const NotificationChannelSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['webhook', 'slack', 'discord', 'ntfy', 'telegram']),
  url: z.string().min(1).max(1000),
  enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).default(1),
});

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
  SettingsSchema,
  NotificationChannelSchema,
  ResultsRangeSchema,
  OrderSchema,
  EnabledSchema,
};
