// Sanitized local runtime records captured 2026-09-06. Display evidence, not a transfer test.
export default {
  "success": {
    "row": {
      "transferId": "preview-success",
      "operationType": "transfer",
      "artifactSizeBytes": 3275,
      "platformName": "Surveyor",
      "platformIndex": 82,
      "forceName": "player",
      "sourceInstanceId": 1,
      "sourceInstanceName": "Nauvis cluster",
      "targetInstanceId": 2,
      "targetInstanceName": "Frontier cluster",
      "status": "completed",
      "startedAt": 1788629601196,
      "completedAt": 1788629601320,
      "failedAt": null,
      "error": null
    },
    "detail": {
      "transferInfo": {
        "transferId": "preview-success",
        "operationType": "transfer",
        "artifactSizeBytes": 3275,
        "platformName": "Surveyor",
        "platformIndex": 82,
        "forceName": "player",
        "sourceInstanceId": 1,
        "sourceInstanceName": "Nauvis cluster",
        "targetInstanceId": 2,
        "targetInstanceName": "Frontier cluster",
        "status": "completed",
        "startedAt": 1788629601196,
        "completedAt": 1788629601320,
        "failedAt": null,
        "error": null
      },
      "summary": {
        "transferId": "preview-success",
        "operationType": "transfer",
        "result": "SUCCESS",
        "status": "completed",
        "totalDurationMs": 124,
        "totalDurationStr": "124ms",
        "phases": {
          "exportTickEstimateMs": 0,
          "transmissionMs": 43,
          "validationMs": 36,
          "cleanupMs": 43
        },
        "platform": {
          "name": "Surveyor",
          "source": {
            "instanceId": 1,
            "instanceName": "Nauvis cluster"
          },
          "destination": {
            "instanceId": 2,
            "instanceName": "Frontier cluster"
          }
        },
        "export": {
          "instanceAsyncExportTicks": 0,
          "instanceAsyncExportMs": 0,
          "instanceAsyncExportSeconds": 0,
          "exportedEntityCount": 6,
          "exportedTileCount": 493,
          "atomicBeltEntitiesScanned": 0,
          "atomicBeltItemStacksCaptured": 0,
          "uncompressedPayloadBytes": 33700,
          "compressedPayloadBytes": 2980,
          "compressionReductionPct": 91.2,
          "scheduleRecordCount": 0,
          "scheduleInterruptCount": 0
        },
        "payload": {
          "isCompressed": true,
          "compressionType": "deflate",
          "payloadSizeKB": 2.9,
          "entityCount": 6,
          "tileCount": 493,
          "uniqueItemTypes": 2,
          "totalItemCount": 60,
          "uniqueFluidTypes": 0,
          "totalFluidVolume": 0
        },
        "import": {
          "total_ticks": 1,
          "tiles_ticks": 0,
          "tiles_ms": 0,
          "entities_ticks": 0,
          "entities_ms": 0,
          "fluids_ticks": 0,
          "fluids_ms": 0,
          "belts_ticks": 0,
          "belts_ms": 0,
          "state_ticks": 0,
          "state_ms": 0,
          "validation_ticks": 0,
          "validation_ms": 0,
          "total_ms": 17,
          "tiles_placed": 493,
          "entities_created": 5,
          "entities_failed": 0,
          "entities_skipped": 1,
          "entities_mapped": 6,
          "fluids_restored": 0,
          "belt_items_restored": 0,
          "belt_state_applied": 0,
          "belt_state_unmatched": 0,
          "belt_state_failed": 0,
          "belt_state_merge_discarded": 0,
          "belt_state_declined": 0,
          "inventory_state_applied": 0,
          "inventory_state_declined": 0,
          "inventory_state_failed": 0,
          "circuits_connected": 0,
          "copper_pruned": 0,
          "proxies_linked": 0,
          "total_items": 60,
          "total_fluids": 0,
          "phaseSpans": [
            {
              "name": "delivery",
              "startOffsetMs": 0,
              "durationMs": 0
            },
            {
              "name": "queue",
              "startOffsetMs": 0,
              "durationMs": 0
            },
            {
              "name": "tiles",
              "startOffsetMs": 0,
              "durationMs": 0
            },
            {
              "name": "entities",
              "startOffsetMs": 0,
              "durationMs": 0
            },
            {
              "name": "hub",
              "startOffsetMs": 0,
              "durationMs": 0
            },
            {
              "name": "belts",
              "startOffsetMs": 0,
              "durationMs": 0
            },
            {
              "name": "state",
              "startOffsetMs": 0,
              "durationMs": 0
            },
            {
              "name": "inventories",
              "startOffsetMs": 16,
              "durationMs": 0
            },
            {
              "name": "held_items",
              "startOffsetMs": 16,
              "durationMs": 0
            },
            {
              "name": "fluids",
              "startOffsetMs": 16,
              "durationMs": 0
            },
            {
              "name": "validation",
              "startOffsetMs": 16,
              "durationMs": 0
            },
            {
              "name": "activation",
              "startOffsetMs": 16,
              "durationMs": 0
            },
            {
              "name": "loss_analysis",
              "startOffsetMs": 16,
              "durationMs": 0
            }
          ]
        },
        "validation": {
          "itemCountMatch": true,
          "fluidCountMatch": true,
          "entityCount": 6,
          "expectedItemCounts": {
            "space-platform-foundation": 10,
            "coal": 50
          },
          "actualItemCounts": {
            "space-platform-foundation": 10,
            "coal": 50
          },
          "expectedFluidCounts": {},
          "actualFluidCounts": {},
          "entityTypeBreakdown": {
            "space-platform-hub": 1,
            "burner-mining-drill": 1,
            "iron-ore": 4
          },
          "itemTypesExpected": 2,
          "itemTypesActual": 2,
          "fluidTypesExpected": 0,
          "fluidTypesActual": 0,
          "totalExpectedItems": 60,
          "totalActualItems": 60,
          "totalExpectedFluids": 0,
          "totalActualFluids": 0,
          "itemLossByType": {},
          "totalItemLoss": 0,
          "fluidReconciliation": {
            "reconciledLoss": 0,
            "lowTempLoss": 0,
            "highTempReconciledLoss": 0,
            "expectedHighTemp": {},
            "actualHighTemp": {},
            "allHighTempNames": {},
            "highTempAggregates": {},
            "totalExpected": 0,
            "totalActual": 0,
            "rawDelta": 0,
            "fluidPreservedPct": 100,
            "highTempThreshold": 10000
          },
          "success": true,
          "reportedEntityCount": 6,
          "postActivationReport": {
            "totalActualItems": 60,
            "actualItemCounts": {
              "space-platform-foundation": 10,
              "coal": 50
            },
            "totalActualFluids": 0,
            "actualFluidCounts": {},
            "fluidReconciliation": {
              "highTempThreshold": 10000,
              "rawFluidDelta": 0,
              "reconciledLoss": 0,
              "lowTempLoss": 0,
              "highTempReconciledLoss": 0,
              "fluidPreservedPct": 100,
              "highTempAggregates": {}
            }
          },
          "sourcePaused": true,
          "sourcePausedApplied": true
        },
        "sourceVerification": {
          "itemCounts": {
            "space-platform-foundation": 10,
            "coal": 50
          },
          "fluidCounts": []
        },
        "startedAt": 1788629601196,
        "completedAt": 1788629601320,
        "failedAt": null,
        "lastEventAt": 1788629601320,
        "error": null
      },
      "events": [
        {
          "timestamp": "2026-09-05T17:33:21.196Z",
          "timestampMs": 1788629601196,
          "elapsedMs": 0,
          "deltaMs": 0,
          "eventType": "transfer_created",
          "message": "transfer created",
          "exportMetrics": {
            "instanceAsyncExportTicks": 0,
            "instanceAsyncExportMs": 0,
            "instanceAsyncExportSeconds": 0,
            "exportedEntityCount": 6,
            "exportedTileCount": 493,
            "atomicBeltEntitiesScanned": 0,
            "atomicBeltItemStacksCaptured": 0,
            "uncompressedPayloadBytes": 33700,
            "compressedPayloadBytes": 2980,
            "compressionReductionPct": 91.2,
            "scheduleRecordCount": 0,
            "scheduleInterruptCount": 0
          },
          "payloadMetrics": {
            "isCompressed": true,
            "compressionType": "deflate",
            "payloadSizeKB": 2.9,
            "entityCount": 6,
            "tileCount": 493,
            "uniqueItemTypes": 2,
            "totalItemCount": 60,
            "uniqueFluidTypes": 0,
            "totalFluidVolume": 0
          }
        },
        {
          "timestamp": "2026-09-05T17:33:21.241Z",
          "timestampMs": 1788629601241,
          "elapsedMs": 45,
          "deltaMs": 45,
          "eventType": "import_started",
          "message": "import started",
          "transmissionMs": 43
        },
        {
          "timestamp": "2026-09-05T17:33:21.277Z",
          "timestampMs": 1788629601277,
          "elapsedMs": 81,
          "deltaMs": 36,
          "eventType": "validation_received",
          "message": "validation received",
          "success": true,
          "validation": {
            "itemCountMatch": true,
            "fluidCountMatch": true,
            "entityCount": 6,
            "expectedItemCounts": {
              "space-platform-foundation": 10,
              "coal": 50
            },
            "actualItemCounts": {
              "space-platform-foundation": 10,
              "coal": 50
            },
            "expectedFluidCounts": {},
            "actualFluidCounts": {},
            "entityTypeBreakdown": {
              "space-platform-hub": 1,
              "burner-mining-drill": 1,
              "iron-ore": 4
            },
            "itemTypesExpected": 2,
            "itemTypesActual": 2,
            "fluidTypesExpected": 0,
            "fluidTypesActual": 0,
            "totalExpectedItems": 60,
            "totalActualItems": 60,
            "totalExpectedFluids": 0,
            "totalActualFluids": 0,
            "itemLossByType": {},
            "totalItemLoss": 0,
            "fluidReconciliation": {
              "reconciledLoss": 0,
              "lowTempLoss": 0,
              "highTempReconciledLoss": 0,
              "expectedHighTemp": {},
              "actualHighTemp": {},
              "allHighTempNames": {},
              "highTempAggregates": {},
              "totalExpected": 0,
              "totalActual": 0,
              "rawDelta": 0,
              "fluidPreservedPct": 100,
              "highTempThreshold": 10000
            },
            "success": true,
            "reportedEntityCount": 6,
            "postActivationReport": {
              "totalActualItems": 60,
              "actualItemCounts": {
                "space-platform-foundation": 10,
                "coal": 50
              },
              "totalActualFluids": 0,
              "actualFluidCounts": {},
              "fluidReconciliation": {
                "highTempThreshold": 10000,
                "rawFluidDelta": 0,
                "reconciledLoss": 0,
                "lowTempLoss": 0,
                "highTempReconciledLoss": 0,
                "fluidPreservedPct": 100,
                "highTempAggregates": {}
              }
            },
            "sourcePaused": true,
            "sourcePausedApplied": true
          },
          "validationMs": 36,
          "importMetrics": {
            "total_ticks": 1,
            "tiles_ticks": 0,
            "tiles_ms": 0,
            "entities_ticks": 0,
            "entities_ms": 0,
            "fluids_ticks": 0,
            "fluids_ms": 0,
            "belts_ticks": 0,
            "belts_ms": 0,
            "state_ticks": 0,
            "state_ms": 0,
            "validation_ticks": 0,
            "validation_ms": 0,
            "total_ms": 17,
            "tiles_placed": 493,
            "entities_created": 5,
            "entities_failed": 0,
            "entities_skipped": 1,
            "entities_mapped": 6,
            "fluids_restored": 0,
            "belt_items_restored": 0,
            "belt_state_applied": 0,
            "belt_state_unmatched": 0,
            "belt_state_failed": 0,
            "belt_state_merge_discarded": 0,
            "belt_state_declined": 0,
            "inventory_state_applied": 0,
            "inventory_state_declined": 0,
            "inventory_state_failed": 0,
            "circuits_connected": 0,
            "copper_pruned": 0,
            "proxies_linked": 0,
            "total_items": 60,
            "total_fluids": 0,
            "phaseSpans": [
              {
                "name": "delivery",
                "startOffsetMs": 0,
                "durationMs": 0
              },
              {
                "name": "queue",
                "startOffsetMs": 0,
                "durationMs": 0
              },
              {
                "name": "tiles",
                "startOffsetMs": 0,
                "durationMs": 0
              },
              {
                "name": "entities",
                "startOffsetMs": 0,
                "durationMs": 0
              },
              {
                "name": "hub",
                "startOffsetMs": 0,
                "durationMs": 0
              },
              {
                "name": "belts",
                "startOffsetMs": 0,
                "durationMs": 0
              },
              {
                "name": "state",
                "startOffsetMs": 0,
                "durationMs": 0
              },
              {
                "name": "inventories",
                "startOffsetMs": 16,
                "durationMs": 0
              },
              {
                "name": "held_items",
                "startOffsetMs": 16,
                "durationMs": 0
              },
              {
                "name": "fluids",
                "startOffsetMs": 16,
                "durationMs": 0
              },
              {
                "name": "validation",
                "startOffsetMs": 16,
                "durationMs": 0
              },
              {
                "name": "activation",
                "startOffsetMs": 16,
                "durationMs": 0
              },
              {
                "name": "loss_analysis",
                "startOffsetMs": 16,
                "durationMs": 0
              }
            ]
          }
        },
        {
          "timestamp": "2026-09-05T17:33:21.320Z",
          "timestampMs": 1788629601320,
          "elapsedMs": 124,
          "deltaMs": 43,
          "eventType": "transfer_completed",
          "message": "transfer completed",
          "durationMs": 124,
          "cleanupMs": 43,
          "phases": {
            "exportTickEstimateMs": 0,
            "transmissionMs": 43,
            "validationMs": 36,
            "cleanupMs": 43
          }
        }
      ],
      "detailRetained": true
    }
  },
  "failure": {
    "row": {
      "transferId": "preview-failure",
      "operationType": "transfer",
      "artifactSizeBytes": 86136,
      "platformName": "Cargo trial",
      "platformIndex": 25,
      "forceName": "player",
      "sourceInstanceId": 1,
      "sourceInstanceName": "Nauvis cluster",
      "targetInstanceId": 2,
      "targetInstanceName": "Frontier cluster",
      "status": "failed",
      "startedAt": 1788606458223,
      "completedAt": 1788606458816,
      "failedAt": null,
      "error": "TEST: forced validation failure (rollback safety test)"
    },
    "detail": {
      "transferInfo": {
        "transferId": "preview-failure",
        "operationType": "transfer",
        "artifactSizeBytes": 86136,
        "platformName": "Cargo trial",
        "platformIndex": 25,
        "forceName": "player",
        "sourceInstanceId": 1,
        "sourceInstanceName": "Nauvis cluster",
        "targetInstanceId": 2,
        "targetInstanceName": "Frontier cluster",
        "status": "failed",
        "startedAt": 1788606458223,
        "completedAt": 1788606458816,
        "failedAt": null,
        "error": "TEST: forced validation failure (rollback safety test)"
      },
      "summary": {
        "transferId": "preview-failure",
        "operationType": "transfer",
        "result": "FAILED",
        "status": "failed",
        "totalDurationMs": 593,
        "totalDurationStr": "593ms",
        "phases": {
          "exportTickEstimateMs": 166,
          "transmissionMs": 90,
          "validationMs": 445
        },
        "platform": {
          "name": "Cargo trial",
          "source": {
            "instanceId": 1,
            "instanceName": "Nauvis cluster"
          },
          "destination": {
            "instanceId": 2,
            "instanceName": "Frontier cluster"
          }
        },
        "export": {
          "instanceAsyncExportTicks": 10,
          "instanceAsyncExportMs": 166,
          "instanceAsyncExportSeconds": 0.16666666666666666,
          "exportedEntityCount": 542,
          "exportedTileCount": 12339,
          "atomicBeltEntitiesScanned": 118,
          "atomicBeltItemStacksCaptured": 855,
          "uncompressedPayloadBytes": 1062217,
          "compressedPayloadBytes": 85024,
          "compressionReductionPct": 92,
          "scheduleRecordCount": 2,
          "scheduleInterruptCount": 1
        },
        "payload": {
          "isCompressed": true,
          "compressionType": "deflate",
          "payloadSizeKB": 83,
          "entityCount": 542,
          "tileCount": 12339,
          "uniqueItemTypes": 25,
          "totalItemCount": 2103,
          "uniqueFluidTypes": 11,
          "totalFluidVolume": 78831.5
        },
        "import": {
          "total_ticks": 11,
          "tiles_ticks": 0,
          "tiles_ms": 0,
          "entities_ticks": 10,
          "entities_ms": 167,
          "fluids_ticks": 0,
          "fluids_ms": 0,
          "belts_ticks": 0,
          "belts_ms": 0,
          "state_ticks": 0,
          "state_ms": 0,
          "validation_ticks": 0,
          "validation_ms": 0,
          "total_ms": 183,
          "tiles_placed": 12339,
          "entities_created": 525,
          "entities_failed": 0,
          "entities_skipped": 1,
          "entities_mapped": 420,
          "fluids_restored": 32,
          "belt_items_restored": 855,
          "belt_state_applied": 0,
          "belt_state_unmatched": 0,
          "belt_state_failed": 0,
          "belt_state_merge_discarded": 0,
          "belt_state_declined": 0,
          "inventory_state_applied": 6,
          "inventory_state_declined": 0,
          "inventory_state_failed": 0,
          "circuits_connected": 34,
          "copper_pruned": 0,
          "proxies_linked": 0,
          "total_items": 2103,
          "total_fluids": 78831,
          "phaseSpans": [
            {
              "name": "delivery",
              "startOffsetMs": 0,
              "durationMs": 0
            },
            {
              "name": "queue",
              "startOffsetMs": 0,
              "durationMs": 0
            },
            {
              "name": "tiles",
              "startOffsetMs": 0,
              "durationMs": 0
            },
            {
              "name": "entities",
              "startOffsetMs": 0,
              "durationMs": 166
            },
            {
              "name": "hub",
              "startOffsetMs": 166,
              "durationMs": 0
            },
            {
              "name": "belts",
              "startOffsetMs": 166,
              "durationMs": 0
            },
            {
              "name": "state",
              "startOffsetMs": 166,
              "durationMs": 0
            },
            {
              "name": "inventories",
              "startOffsetMs": 183,
              "durationMs": 0
            },
            {
              "name": "held_items",
              "startOffsetMs": 183,
              "durationMs": 0
            },
            {
              "name": "fluids",
              "startOffsetMs": 183,
              "durationMs": 0
            },
            {
              "name": "validation",
              "startOffsetMs": 183,
              "durationMs": 0
            }
          ]
        },
        "validation": {
          "itemCountMatch": false,
          "fluidCountMatch": false,
          "entityCount": 542,
          "expectedItemCounts": {
            "iron-plate": 1302,
            "copper-plate": 374,
            "turbo-transport-belt": 23,
            "turbo-underground-belt": 6,
            "turbo-splitter": 3,
            "turbo-loader": 2,
            "space-platform-foundation": 8,
            "power-armor-mk2": 2,
            "blueprint": 2,
            "blueprint-book": 2,
            "deconstruction-planner": 2,
            "repair-pack": 2,
            "piercing-rounds-magazine": 2,
            "spoilage": 20,
            "iron-gear-wheel": 7,
            "coal": 20,
            "sulfur": 8,
            "raw-fish": 20,
            "fusion-power-cell": 90,
            "carbonic-asteroid-chunk": 138,
            "oxide-asteroid-chunk": 24,
            "metallic-asteroid-chunk": 24,
            "productivity-module": 4,
            "railgun-ammo:legendary": 16,
            "uranium-ore": 2
          },
          "actualItemCounts": {
            "turbo-transport-belt": 23,
            "turbo-underground-belt": 6,
            "turbo-splitter": 3,
            "turbo-loader": 2,
            "space-platform-foundation": 8,
            "power-armor-mk2": 2,
            "blueprint": 2,
            "blueprint-book": 2,
            "deconstruction-planner": 2,
            "repair-pack": 2,
            "piercing-rounds-magazine": 2,
            "spoilage": 20,
            "sulfur": 8,
            "iron-gear-wheel": 7,
            "coal": 20,
            "iron-plate": 1302,
            "copper-plate": 374,
            "raw-fish": 20,
            "fusion-power-cell": 90,
            "carbonic-asteroid-chunk": 138,
            "oxide-asteroid-chunk": 24,
            "metallic-asteroid-chunk": 24,
            "productivity-module": 4,
            "railgun-ammo:legendary": 16,
            "uranium-ore": 2
          },
          "expectedFluidCounts": {
            "light-oil@25.0C": 3902,
            "thruster-oxidizer@25.0C": 2200,
            "petroleum-gas@25.0C": 286,
            "thruster-fuel@25.0C": 2600,
            "steam@500.0C": 40000,
            "molten-iron@1500.0C": 500,
            "fluoroketone-cold@-150.0C": 395.7704565525055,
            "fusion-plasma@1000000.0C": 239.9996565580368,
            "water@15.0C": 2000,
            "fluoroketone-hot@180.0C": 9.70089590549469,
            "sulfuric-acid@25.0C": 26698
          },
          "actualFluidCounts": {
            "steam@500.0C": 40000,
            "molten-iron@1500.0C": 500,
            "fluoroketone-cold@-150.0C": 395.7704565525055,
            "fusion-plasma@1000000.0C": 239.9996565580368,
            "fluoroketone-hot@180.0C": 9.70089590549469,
            "water@15.0C": 2000,
            "sulfuric-acid@25.0C": 26698,
            "light-oil@25.0C": 3902,
            "thruster-oxidizer@25.0C": 2200,
            "thruster-fuel@25.0C": 2600,
            "petroleum-gas@25.0C": 286
          },
          "entityTypeBreakdown": {
            "space-platform-hub": 1,
            "display-panel": 65,
            "steel-chest": 20,
            "assembling-machine-2": 7,
            "splitter": 2,
            "constant-combinator": 30,
            "storage-tank": 6,
            "chemical-plant": 2,
            "assembling-machine-1": 3,
            "burner-inserter": 2,
            "foundry": 2,
            "inserter": 1,
            "turbo-transport-belt": 94,
            "turbo-underground-belt": 12,
            "turbo-splitter": 6,
            "turbo-loader": 4,
            "spidertron-leg-5": 2,
            "spidertron-leg-6": 2,
            "spidertron": 2,
            "heat-pipe": 2,
            "spidertron-leg-1": 2,
            "spidertron-leg-2": 2,
            "spidertron-leg-7": 2,
            "spidertron-leg-8": 2,
            "entity-ghost": 2,
            "beacon": 1,
            "tile-ghost": 2,
            "spidertron-leg-3": 2,
            "spidertron-leg-4": 2,
            "item-request-proxy": 2,
            "accumulator": 4,
            "fusion-reactor": 2,
            "pipe": 48,
            "medium-electric-pole": 6,
            "infinity-pipe": 2,
            "cryogenic-plant": 2,
            "fusion-generator": 2,
            "decider-combinator": 4,
            "solar-panel": 2,
            "item-on-ground": 106,
            "big-mining-drill": 2,
            "uranium-ore": 8,
            "small-lamp": 2,
            "bulk-inserter": 12,
            "pipe-to-ground": 48,
            "thruster": 4,
            "pump": 4
          },
          "itemTypesExpected": 25,
          "itemTypesActual": 25,
          "fluidTypesExpected": 11,
          "fluidTypesActual": 11,
          "totalExpectedItems": 2103,
          "totalActualItems": 2103,
          "totalExpectedFluids": 78831.47100901604,
          "totalActualFluids": 78831.47100901604,
          "itemLossByType": {},
          "totalItemLoss": 0,
          "fluidReconciliation": {
            "reconciledLoss": 0,
            "lowTempLoss": 0,
            "highTempReconciledLoss": 0,
            "expectedHighTemp": {
              "fusion-plasma": 239.9996565580368
            },
            "actualHighTemp": {
              "fusion-plasma": 239.9996565580368
            },
            "allHighTempNames": {
              "fusion-plasma": true
            },
            "highTempAggregates": {
              "fusion-plasma": {
                "expected": 239.9996565580368,
                "actual": 239.9996565580368,
                "delta": 0,
                "reconciled": true,
                "expectedEnergy": 239999656.5580368,
                "actualEnergy": 239999656.5580368
              }
            },
            "totalExpected": 78831.47100901604,
            "totalActual": 78831.47100901604,
            "rawDelta": 0,
            "fluidPreservedPct": 100,
            "highTempThreshold": 10000
          },
          "success": false,
          "failedStage": "items",
          "mismatchDetails": "TEST: forced validation failure (rollback safety test)",
          "message": "TEST: validation failure forced (test_force_validation_failure)",
          "testForcedFailure": true,
          "reportedEntityCount": 526
        },
        "sourceVerification": {
          "itemCounts": {
            "iron-plate": 1302,
            "copper-plate": 374,
            "turbo-transport-belt": 23,
            "turbo-underground-belt": 6,
            "turbo-splitter": 3,
            "turbo-loader": 2,
            "space-platform-foundation": 8,
            "power-armor-mk2": 2,
            "blueprint": 2,
            "blueprint-book": 2,
            "deconstruction-planner": 2,
            "repair-pack": 2,
            "piercing-rounds-magazine": 2,
            "spoilage": 20,
            "iron-gear-wheel": 7,
            "coal": 20,
            "sulfur": 8,
            "raw-fish": 20,
            "fusion-power-cell": 90,
            "carbonic-asteroid-chunk": 138,
            "oxide-asteroid-chunk": 24,
            "metallic-asteroid-chunk": 24,
            "productivity-module": 4,
            "railgun-ammo:legendary": 16,
            "uranium-ore": 2
          },
          "fluidCounts": {
            "light-oil@25.0C": 3902,
            "thruster-oxidizer@25.0C": 2200,
            "petroleum-gas@25.0C": 286,
            "thruster-fuel@25.0C": 2600,
            "steam@500.0C": 40000,
            "molten-iron@1500.0C": 500,
            "fluoroketone-cold@-150.0C": 395.77045655251,
            "fusion-plasma@1000000.0C": 239.99965655804,
            "water@15.0C": 2000,
            "fluoroketone-hot@180.0C": 9.7008959054947,
            "sulfuric-acid@25.0C": 26698
          }
        },
        "startedAt": 1788606458223,
        "completedAt": 1788606458816,
        "failedAt": null,
        "lastEventAt": 1788606458816,
        "error": "TEST: forced validation failure (rollback safety test)"
      },
      "events": [
        {
          "timestamp": "2026-09-05T11:07:38.223Z",
          "timestampMs": 1788606458223,
          "elapsedMs": 0,
          "deltaMs": 0,
          "eventType": "transfer_created",
          "message": "transfer created",
          "exportMetrics": {
            "instanceAsyncExportTicks": 10,
            "instanceAsyncExportMs": 166,
            "instanceAsyncExportSeconds": 0.16666666666666666,
            "exportedEntityCount": 542,
            "exportedTileCount": 12339,
            "atomicBeltEntitiesScanned": 118,
            "atomicBeltItemStacksCaptured": 855,
            "uncompressedPayloadBytes": 1062217,
            "compressedPayloadBytes": 85024,
            "compressionReductionPct": 92,
            "scheduleRecordCount": 2,
            "scheduleInterruptCount": 1
          },
          "payloadMetrics": {
            "isCompressed": true,
            "compressionType": "deflate",
            "payloadSizeKB": 83,
            "entityCount": 542,
            "tileCount": 12339,
            "uniqueItemTypes": 25,
            "totalItemCount": 2103,
            "uniqueFluidTypes": 11,
            "totalFluidVolume": 78831.5
          }
        },
        {
          "timestamp": "2026-09-05T11:07:38.313Z",
          "timestampMs": 1788606458313,
          "elapsedMs": 90,
          "deltaMs": 90,
          "eventType": "import_started",
          "message": "import started",
          "transmissionMs": 90
        },
        {
          "timestamp": "2026-09-05T11:07:38.758Z",
          "timestampMs": 1788606458758,
          "elapsedMs": 535,
          "deltaMs": 445,
          "eventType": "validation_received",
          "message": "validation received",
          "success": false,
          "validation": {
            "itemCountMatch": false,
            "fluidCountMatch": false,
            "entityCount": 542,
            "expectedItemCounts": {
              "iron-plate": 1302,
              "copper-plate": 374,
              "turbo-transport-belt": 23,
              "turbo-underground-belt": 6,
              "turbo-splitter": 3,
              "turbo-loader": 2,
              "space-platform-foundation": 8,
              "power-armor-mk2": 2,
              "blueprint": 2,
              "blueprint-book": 2,
              "deconstruction-planner": 2,
              "repair-pack": 2,
              "piercing-rounds-magazine": 2,
              "spoilage": 20,
              "iron-gear-wheel": 7,
              "coal": 20,
              "sulfur": 8,
              "raw-fish": 20,
              "fusion-power-cell": 90,
              "carbonic-asteroid-chunk": 138,
              "oxide-asteroid-chunk": 24,
              "metallic-asteroid-chunk": 24,
              "productivity-module": 4,
              "railgun-ammo:legendary": 16,
              "uranium-ore": 2
            },
            "actualItemCounts": {
              "turbo-transport-belt": 23,
              "turbo-underground-belt": 6,
              "turbo-splitter": 3,
              "turbo-loader": 2,
              "space-platform-foundation": 8,
              "power-armor-mk2": 2,
              "blueprint": 2,
              "blueprint-book": 2,
              "deconstruction-planner": 2,
              "repair-pack": 2,
              "piercing-rounds-magazine": 2,
              "spoilage": 20,
              "sulfur": 8,
              "iron-gear-wheel": 7,
              "coal": 20,
              "iron-plate": 1302,
              "copper-plate": 374,
              "raw-fish": 20,
              "fusion-power-cell": 90,
              "carbonic-asteroid-chunk": 138,
              "oxide-asteroid-chunk": 24,
              "metallic-asteroid-chunk": 24,
              "productivity-module": 4,
              "railgun-ammo:legendary": 16,
              "uranium-ore": 2
            },
            "expectedFluidCounts": {
              "light-oil@25.0C": 3902,
              "thruster-oxidizer@25.0C": 2200,
              "petroleum-gas@25.0C": 286,
              "thruster-fuel@25.0C": 2600,
              "steam@500.0C": 40000,
              "molten-iron@1500.0C": 500,
              "fluoroketone-cold@-150.0C": 395.7704565525055,
              "fusion-plasma@1000000.0C": 239.9996565580368,
              "water@15.0C": 2000,
              "fluoroketone-hot@180.0C": 9.70089590549469,
              "sulfuric-acid@25.0C": 26698
            },
            "actualFluidCounts": {
              "steam@500.0C": 40000,
              "molten-iron@1500.0C": 500,
              "fluoroketone-cold@-150.0C": 395.7704565525055,
              "fusion-plasma@1000000.0C": 239.9996565580368,
              "fluoroketone-hot@180.0C": 9.70089590549469,
              "water@15.0C": 2000,
              "sulfuric-acid@25.0C": 26698,
              "light-oil@25.0C": 3902,
              "thruster-oxidizer@25.0C": 2200,
              "thruster-fuel@25.0C": 2600,
              "petroleum-gas@25.0C": 286
            },
            "entityTypeBreakdown": {
              "space-platform-hub": 1,
              "display-panel": 65,
              "steel-chest": 20,
              "assembling-machine-2": 7,
              "splitter": 2,
              "constant-combinator": 30,
              "storage-tank": 6,
              "chemical-plant": 2,
              "assembling-machine-1": 3,
              "burner-inserter": 2,
              "foundry": 2,
              "inserter": 1,
              "turbo-transport-belt": 94,
              "turbo-underground-belt": 12,
              "turbo-splitter": 6,
              "turbo-loader": 4,
              "spidertron-leg-5": 2,
              "spidertron-leg-6": 2,
              "spidertron": 2,
              "heat-pipe": 2,
              "spidertron-leg-1": 2,
              "spidertron-leg-2": 2,
              "spidertron-leg-7": 2,
              "spidertron-leg-8": 2,
              "entity-ghost": 2,
              "beacon": 1,
              "tile-ghost": 2,
              "spidertron-leg-3": 2,
              "spidertron-leg-4": 2,
              "item-request-proxy": 2,
              "accumulator": 4,
              "fusion-reactor": 2,
              "pipe": 48,
              "medium-electric-pole": 6,
              "infinity-pipe": 2,
              "cryogenic-plant": 2,
              "fusion-generator": 2,
              "decider-combinator": 4,
              "solar-panel": 2,
              "item-on-ground": 106,
              "big-mining-drill": 2,
              "uranium-ore": 8,
              "small-lamp": 2,
              "bulk-inserter": 12,
              "pipe-to-ground": 48,
              "thruster": 4,
              "pump": 4
            },
            "itemTypesExpected": 25,
            "itemTypesActual": 25,
            "fluidTypesExpected": 11,
            "fluidTypesActual": 11,
            "totalExpectedItems": 2103,
            "totalActualItems": 2103,
            "totalExpectedFluids": 78831.47100901604,
            "totalActualFluids": 78831.47100901604,
            "itemLossByType": {},
            "totalItemLoss": 0,
            "fluidReconciliation": {
              "reconciledLoss": 0,
              "lowTempLoss": 0,
              "highTempReconciledLoss": 0,
              "expectedHighTemp": {
                "fusion-plasma": 239.9996565580368
              },
              "actualHighTemp": {
                "fusion-plasma": 239.9996565580368
              },
              "allHighTempNames": {
                "fusion-plasma": true
              },
              "highTempAggregates": {
                "fusion-plasma": {
                  "expected": 239.9996565580368,
                  "actual": 239.9996565580368,
                  "delta": 0,
                  "reconciled": true,
                  "expectedEnergy": 239999656.5580368,
                  "actualEnergy": 239999656.5580368
                }
              },
              "totalExpected": 78831.47100901604,
              "totalActual": 78831.47100901604,
              "rawDelta": 0,
              "fluidPreservedPct": 100,
              "highTempThreshold": 10000
            },
            "success": false,
            "failedStage": "items",
            "mismatchDetails": "TEST: forced validation failure (rollback safety test)",
            "message": "TEST: validation failure forced (test_force_validation_failure)",
            "testForcedFailure": true,
            "reportedEntityCount": 526
          },
          "validationMs": 445,
          "importMetrics": {
            "total_ticks": 11,
            "tiles_ticks": 0,
            "tiles_ms": 0,
            "entities_ticks": 10,
            "entities_ms": 167,
            "fluids_ticks": 0,
            "fluids_ms": 0,
            "belts_ticks": 0,
            "belts_ms": 0,
            "state_ticks": 0,
            "state_ms": 0,
            "validation_ticks": 0,
            "validation_ms": 0,
            "total_ms": 183,
            "tiles_placed": 12339,
            "entities_created": 525,
            "entities_failed": 0,
            "entities_skipped": 1,
            "entities_mapped": 420,
            "fluids_restored": 32,
            "belt_items_restored": 855,
            "belt_state_applied": 0,
            "belt_state_unmatched": 0,
            "belt_state_failed": 0,
            "belt_state_merge_discarded": 0,
            "belt_state_declined": 0,
            "inventory_state_applied": 6,
            "inventory_state_declined": 0,
            "inventory_state_failed": 0,
            "circuits_connected": 34,
            "copper_pruned": 0,
            "proxies_linked": 0,
            "total_items": 2103,
            "total_fluids": 78831,
            "phaseSpans": [
              {
                "name": "delivery",
                "startOffsetMs": 0,
                "durationMs": 0
              },
              {
                "name": "queue",
                "startOffsetMs": 0,
                "durationMs": 0
              },
              {
                "name": "tiles",
                "startOffsetMs": 0,
                "durationMs": 0
              },
              {
                "name": "entities",
                "startOffsetMs": 0,
                "durationMs": 166
              },
              {
                "name": "hub",
                "startOffsetMs": 166,
                "durationMs": 0
              },
              {
                "name": "belts",
                "startOffsetMs": 166,
                "durationMs": 0
              },
              {
                "name": "state",
                "startOffsetMs": 166,
                "durationMs": 0
              },
              {
                "name": "inventories",
                "startOffsetMs": 183,
                "durationMs": 0
              },
              {
                "name": "held_items",
                "startOffsetMs": 183,
                "durationMs": 0
              },
              {
                "name": "fluids",
                "startOffsetMs": 183,
                "durationMs": 0
              },
              {
                "name": "validation",
                "startOffsetMs": 183,
                "durationMs": 0
              }
            ]
          }
        },
        {
          "timestamp": "2026-09-05T11:07:38.758Z",
          "timestampMs": 1788606458758,
          "elapsedMs": 535,
          "deltaMs": 0,
          "eventType": "validation_failed",
          "message": "validation failed",
          "validation": {
            "itemCountMatch": false,
            "fluidCountMatch": false,
            "entityCount": 542,
            "expectedItemCounts": {
              "iron-plate": 1302,
              "copper-plate": 374,
              "turbo-transport-belt": 23,
              "turbo-underground-belt": 6,
              "turbo-splitter": 3,
              "turbo-loader": 2,
              "space-platform-foundation": 8,
              "power-armor-mk2": 2,
              "blueprint": 2,
              "blueprint-book": 2,
              "deconstruction-planner": 2,
              "repair-pack": 2,
              "piercing-rounds-magazine": 2,
              "spoilage": 20,
              "iron-gear-wheel": 7,
              "coal": 20,
              "sulfur": 8,
              "raw-fish": 20,
              "fusion-power-cell": 90,
              "carbonic-asteroid-chunk": 138,
              "oxide-asteroid-chunk": 24,
              "metallic-asteroid-chunk": 24,
              "productivity-module": 4,
              "railgun-ammo:legendary": 16,
              "uranium-ore": 2
            },
            "actualItemCounts": {
              "turbo-transport-belt": 23,
              "turbo-underground-belt": 6,
              "turbo-splitter": 3,
              "turbo-loader": 2,
              "space-platform-foundation": 8,
              "power-armor-mk2": 2,
              "blueprint": 2,
              "blueprint-book": 2,
              "deconstruction-planner": 2,
              "repair-pack": 2,
              "piercing-rounds-magazine": 2,
              "spoilage": 20,
              "sulfur": 8,
              "iron-gear-wheel": 7,
              "coal": 20,
              "iron-plate": 1302,
              "copper-plate": 374,
              "raw-fish": 20,
              "fusion-power-cell": 90,
              "carbonic-asteroid-chunk": 138,
              "oxide-asteroid-chunk": 24,
              "metallic-asteroid-chunk": 24,
              "productivity-module": 4,
              "railgun-ammo:legendary": 16,
              "uranium-ore": 2
            },
            "expectedFluidCounts": {
              "light-oil@25.0C": 3902,
              "thruster-oxidizer@25.0C": 2200,
              "petroleum-gas@25.0C": 286,
              "thruster-fuel@25.0C": 2600,
              "steam@500.0C": 40000,
              "molten-iron@1500.0C": 500,
              "fluoroketone-cold@-150.0C": 395.7704565525055,
              "fusion-plasma@1000000.0C": 239.9996565580368,
              "water@15.0C": 2000,
              "fluoroketone-hot@180.0C": 9.70089590549469,
              "sulfuric-acid@25.0C": 26698
            },
            "actualFluidCounts": {
              "steam@500.0C": 40000,
              "molten-iron@1500.0C": 500,
              "fluoroketone-cold@-150.0C": 395.7704565525055,
              "fusion-plasma@1000000.0C": 239.9996565580368,
              "fluoroketone-hot@180.0C": 9.70089590549469,
              "water@15.0C": 2000,
              "sulfuric-acid@25.0C": 26698,
              "light-oil@25.0C": 3902,
              "thruster-oxidizer@25.0C": 2200,
              "thruster-fuel@25.0C": 2600,
              "petroleum-gas@25.0C": 286
            },
            "entityTypeBreakdown": {
              "space-platform-hub": 1,
              "display-panel": 65,
              "steel-chest": 20,
              "assembling-machine-2": 7,
              "splitter": 2,
              "constant-combinator": 30,
              "storage-tank": 6,
              "chemical-plant": 2,
              "assembling-machine-1": 3,
              "burner-inserter": 2,
              "foundry": 2,
              "inserter": 1,
              "turbo-transport-belt": 94,
              "turbo-underground-belt": 12,
              "turbo-splitter": 6,
              "turbo-loader": 4,
              "spidertron-leg-5": 2,
              "spidertron-leg-6": 2,
              "spidertron": 2,
              "heat-pipe": 2,
              "spidertron-leg-1": 2,
              "spidertron-leg-2": 2,
              "spidertron-leg-7": 2,
              "spidertron-leg-8": 2,
              "entity-ghost": 2,
              "beacon": 1,
              "tile-ghost": 2,
              "spidertron-leg-3": 2,
              "spidertron-leg-4": 2,
              "item-request-proxy": 2,
              "accumulator": 4,
              "fusion-reactor": 2,
              "pipe": 48,
              "medium-electric-pole": 6,
              "infinity-pipe": 2,
              "cryogenic-plant": 2,
              "fusion-generator": 2,
              "decider-combinator": 4,
              "solar-panel": 2,
              "item-on-ground": 106,
              "big-mining-drill": 2,
              "uranium-ore": 8,
              "small-lamp": 2,
              "bulk-inserter": 12,
              "pipe-to-ground": 48,
              "thruster": 4,
              "pump": 4
            },
            "itemTypesExpected": 25,
            "itemTypesActual": 25,
            "fluidTypesExpected": 11,
            "fluidTypesActual": 11,
            "totalExpectedItems": 2103,
            "totalActualItems": 2103,
            "totalExpectedFluids": 78831.47100901604,
            "totalActualFluids": 78831.47100901604,
            "itemLossByType": {},
            "totalItemLoss": 0,
            "fluidReconciliation": {
              "reconciledLoss": 0,
              "lowTempLoss": 0,
              "highTempReconciledLoss": 0,
              "expectedHighTemp": {
                "fusion-plasma": 239.9996565580368
              },
              "actualHighTemp": {
                "fusion-plasma": 239.9996565580368
              },
              "allHighTempNames": {
                "fusion-plasma": true
              },
              "highTempAggregates": {
                "fusion-plasma": {
                  "expected": 239.9996565580368,
                  "actual": 239.9996565580368,
                  "delta": 0,
                  "reconciled": true,
                  "expectedEnergy": 239999656.5580368,
                  "actualEnergy": 239999656.5580368
                }
              },
              "totalExpected": 78831.47100901604,
              "totalActual": 78831.47100901604,
              "rawDelta": 0,
              "fluidPreservedPct": 100,
              "highTempThreshold": 10000
            },
            "success": false,
            "failedStage": "items",
            "mismatchDetails": "TEST: forced validation failure (rollback safety test)",
            "message": "TEST: validation failure forced (test_force_validation_failure)",
            "testForcedFailure": true,
            "reportedEntityCount": 526
          }
        },
        {
          "timestamp": "2026-09-05T11:07:38.783Z",
          "timestampMs": 1788606458783,
          "elapsedMs": 560,
          "deltaMs": 25,
          "eventType": "rollback_attempt",
          "message": "rollback attempt"
        },
        {
          "timestamp": "2026-09-05T11:07:38.792Z",
          "timestampMs": 1788606458792,
          "elapsedMs": 569,
          "deltaMs": 9,
          "eventType": "rollback_success",
          "message": "rollback success"
        },
        {
          "timestamp": "2026-09-05T11:07:38.816Z",
          "timestampMs": 1788606458816,
          "elapsedMs": 593,
          "deltaMs": 24,
          "eventType": "transfer_failed",
          "message": "transfer failed",
          "durationMs": 593,
          "error": "TEST: forced validation failure (rollback safety test)",
          "destinationCleanupError": null
        }
      ],
      "detailRetained": true
    }
  }
};
