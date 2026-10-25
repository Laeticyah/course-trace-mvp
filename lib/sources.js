"use strict";

/**
 * 资料来源渠道注册表
 * —— 统一管理渠道名称、来源标签、采集方式与可信度权重，避免各模块各写一份。
 */

const CHANNELS = [
  { id: "canvas", label: "Canvas", source: "Canvas", kind: "sync", authority: 1, enabled: true, description: "Canvas API 自动同步" },
  { id: "teacher", label: "教师上传", source: "教师上传", kind: "upload", authority: 0.95, enabled: true, description: "教师本地上传或登记" },
  { id: "zhitu", label: "知途好课", source: "知途好课", kind: "upload", authority: 0.92, enabled: true, description: "知途好课资料，手动下载后上传" },
  { id: "class", label: "班级群", source: "班级群", kind: "upload", authority: 0.58, enabled: true, description: "班级群文件，手动下载后上传/链接导入" },
  { id: "pan", label: "网盘", source: "网盘", kind: "url", authority: 0.48, enabled: true, description: "网盘/云盘分享直链，链接导入" },
  { id: "forward", label: "转发", source: "转发", kind: "upload", authority: 0.4, enabled: true, description: "转发来源，可信度最低" },
];

const SOURCE_WEIGHT = Object.fromEntries(CHANNELS.map((channel) => [channel.source, channel.authority]));

function listChannels() {
  return CHANNELS.filter((channel) => channel.enabled).map((channel) => ({
    id: channel.id,
    label: channel.label,
    source: channel.source,
    kind: channel.kind,
    authority: channel.authority,
    description: channel.description,
  }));
}

function isKnownSource(source) {
  return Object.prototype.hasOwnProperty.call(SOURCE_WEIGHT, String(source || ""));
}

function normalizeSource(source, fallback = "教师上传") {
  const value = String(source || "").trim();
  return isKnownSource(value) ? value : fallback;
}

function sourceWeight(source) {
  return SOURCE_WEIGHT[source];
}

module.exports = { CHANNELS, SOURCE_WEIGHT, listChannels, isKnownSource, normalizeSource, sourceWeight };
