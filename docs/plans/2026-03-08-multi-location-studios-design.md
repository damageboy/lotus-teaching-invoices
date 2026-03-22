# Multi-Location Studio Support — Design

## Problem

Some yoga studios (e.g. YFD) have multiple locations. Calendar events for these use the format `"YFD / mitte / Vinyasa"` (two slashes) instead of the single-location `"Studio / ClassType"` (one slash). All locations should aggregate into one invoice per studio.

## Decisions

- **1 slash** → single-location: `studioName / classType`
- **2 slashes** → multi-location: `studioName / location / classType`
- **Invoicing**: all locations roll up to the parent studio — one invoice, one config entry, one rate tier set
- **Event chips**: show `"location / classType"` (studio color identifies the parent)
- **Calendar legend**: single entry per studio; multi-location studios show discovered locations in smaller text
- **Invoice line items**: `classType` displays as `"location / classType"` when location exists
- **Config**: no changes to config.yaml schema — multi-location studios are a single entry
