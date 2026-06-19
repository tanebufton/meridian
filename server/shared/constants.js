'use strict';

const STATUS = {
  UP: 'UP',
  DEGRADED: 'DEGRADED',
  DOWN: 'DOWN',
  UNKNOWN: 'UNKNOWN',
};

const STATUS_THRESHOLDS = {
  UP_MAX_LOSS: 5,
  DEGRADED_MAX_LOSS: 50,
};

function getStatus(packetLoss, dnsSuccess, probeType, hasError) {
  if (hasError) return STATUS.DOWN;
  if (probeType === 'dns') {
    if (dnsSuccess === 1) return STATUS.UP;
    if (dnsSuccess === 0) return STATUS.DOWN;
    return STATUS.UNKNOWN;
  }
  if (packetLoss === null || packetLoss === undefined) return STATUS.UNKNOWN;
  if (packetLoss < STATUS_THRESHOLDS.UP_MAX_LOSS) return STATUS.UP;
  if (packetLoss <= STATUS_THRESHOLDS.DEGRADED_MAX_LOSS) return STATUS.DEGRADED;
  return STATUS.DOWN;
}

const METRIC_LABELS = {
  latency_avg: 'Avg Latency',
  latency_max: 'Max Latency',
  packet_loss: 'Packet Loss',
  dns_time: 'DNS Time',
};

const METRIC_UNITS = {
  latency_avg: 'ms',
  latency_max: 'ms',
  packet_loss: '%',
  dns_time: 'ms',
};

module.exports = { STATUS, STATUS_THRESHOLDS, getStatus, METRIC_LABELS, METRIC_UNITS };
