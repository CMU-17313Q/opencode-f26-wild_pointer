import { z } from "zod";

// Canonical source: https://a2a-protocol.org/latest/specification/
// Proto: https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto

// JSON field names are camelCase (§5.5). 
// Enum values are SCREAMING_SNAKE_CASE (v1.0).

export const TaskStateSchema = z.enum([
  "TASK_STATE_UNSPECIFIED",
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const RoleSchema = z.enum([
  "ROLE_UNSPECIFIED",
  "ROLE_USER",
  "ROLE_AGENT",
]);
export type Role = z.infer<typeof RoleSchema>;

// Part (text only). Full spec is oneof { text, raw, url, data } —
// this minimal subset supports text parts only.
export const PartSchema = z.object({
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  filename: z.string().optional(),
  mediaType: z.string().optional(),
});
export type Part = z.infer<typeof PartSchema>;

export const MessageSchema = z.object({
  messageId: z.string(),
  role: RoleSchema,
  parts: z.array(PartSchema).min(1),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const TaskStatusSchema = z.object({
  state: TaskStateSchema,
  message: MessageSchema.optional(),
  timestamp: z.string().optional(),
});
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const ArtifactSchema = z.object({
  artifactId: z.string(),
  parts: z.array(PartSchema).min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extensions: z.array(z.string()).optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  status: TaskStatusSchema,
  contextId: z.string().optional(),
  artifacts: z.array(ArtifactSchema).optional(),
  history: z.array(MessageSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskStatusUpdateEventSchema = z.object({
  taskId: z.string(),
  contextId: z.string(),
  status: TaskStatusSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type TaskStatusUpdateEvent = z.infer<typeof TaskStatusUpdateEventSchema>;

export const TaskArtifactUpdateEventSchema = z.object({
  taskId: z.string(),
  contextId: z.string(),
  artifact: ArtifactSchema,
  append: z.boolean().optional(),
  lastChunk: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type TaskArtifactUpdateEvent = z.infer<typeof TaskArtifactUpdateEventSchema>;

export const SendMessageResponseSchema = z.union([TaskSchema, MessageSchema]);
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

export const StreamEventSchema = z.union([
  TaskSchema,
  MessageSchema,
  TaskStatusUpdateEventSchema,
  TaskArtifactUpdateEventSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const TaskListSchema = z.object({
  tasks: z.array(TaskSchema),
  nextPageToken: z.string(),
  pageSize: z.number(),
  totalSize: z.number(),
});
export type TaskList = z.infer<typeof TaskListSchema>;

export const AgentInterfaceSchema = z.object({
  url: z.string(),
  protocolBinding: z.string(),
  protocolVersion: z.string(),
  tenant: z.string().optional(),
});
export type AgentInterface = z.infer<typeof AgentInterfaceSchema>;

export const AgentCapabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  extendedAgentCard: z.boolean().optional(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

export const AgentProviderSchema = z.object({
  organization: z.string(),
  url: z.string(),
});
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

export const AgentSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});
export type AgentSkill = z.infer<typeof AgentSkillSchema>;

export const AgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  supportedInterfaces: z.array(AgentInterfaceSchema).min(1),
  capabilities: AgentCapabilitiesSchema,
  defaultInputModes: z.array(z.string()),
  defaultOutputModes: z.array(z.string()),
  skills: z.array(AgentSkillSchema),
  provider: AgentProviderSchema.optional(),
  documentationUrl: z.string().optional(),
  iconUrl: z.string().optional(),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;
