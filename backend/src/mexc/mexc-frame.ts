import * as protobuf from 'protobufjs';

export type MexcFrame = { kind: 'control'; value: Record<string, unknown> } | { kind: 'protobuf'; value: Record<string, unknown> };

export function decodeMexcFrame(wrapper: protobuf.Type, raw: Buffer): MexcFrame {
  const text = raw.toString('utf8').trimStart();
  if (text.startsWith('{')) return { kind: 'control', value: JSON.parse(text) };
  const decoded = wrapper.decode(raw);
  return { kind: 'protobuf', value: wrapper.toObject(decoded, { longs: String, defaults: false }) };
}
