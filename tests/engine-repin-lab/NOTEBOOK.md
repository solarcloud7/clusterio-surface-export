

## 2026-07-10T06:10:08.979Z - LAB-I B7-B9 engine re-pin

Predictions were recorded before execution: B7 open; B8 immediate/no-power; B9 graceful skip plus warning.

```json
{
  "script": "tests/engine-repin-lab/run-b7-b9.mjs",
  "started": "2026-07-10T06:09:39.614Z",
  "sections": [
    "b7",
    "b8",
    "b9"
  ],
  "predictions": {
    "b7": "open re-pin",
    "b8": "same-execution crafting_speed update without power dependency",
    "b9": "unknown item skips with warning"
  },
  "rungs": {
    "b7": {
      "success": true,
      "prediction": "open re-pin measurement",
      "variants": [
        {
          "variant": "destroy()",
          "prediction": "measure current-pin behavior; no behavior assumed",
          "setup": {
            "success": true,
            "read": {
              "label": "before",
              "tick": 429874,
              "game_paused": false,
              "valid": true,
              "platform_count": 2,
              "index": 35
            },
            "index": 35
          },
          "immediate": {
            "success": true,
            "call_ok": true,
            "call_error": "nil",
            "read": {
              "label": "same execution",
              "tick": 429916,
              "game_paused": false,
              "valid": true,
              "platform_count": 2,
              "index": 35
            }
          },
          "after1": {
            "label": "first observed elapsed read",
            "tick": 429962,
            "game_paused": false,
            "valid": true,
            "platform_count": 2,
            "index": 35
          },
          "after61": {
            "label": "~61 elapsed ticks",
            "tick": 430072,
            "game_paused": false,
            "valid": true,
            "platform_count": 2,
            "index": 35
          },
          "after120": {
            "label": "~120 elapsed ticks",
            "tick": 430182,
            "game_paused": false,
            "valid": true,
            "platform_count": 2,
            "index": 35
          }
        },
        {
          "variant": "destroy(0)",
          "prediction": "measure current-pin behavior; no behavior assumed",
          "setup": {
            "success": true,
            "read": {
              "label": "before",
              "tick": 430221,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 36
            },
            "index": 36
          },
          "immediate": {
            "success": true,
            "call_ok": true,
            "call_error": "nil",
            "read": {
              "label": "same execution",
              "tick": 430262,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 36
            }
          },
          "after1": {
            "label": "first observed elapsed read",
            "tick": 430308,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          },
          "after61": {
            "label": "~61 elapsed ticks",
            "tick": 430419,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          },
          "after120": {
            "label": "~120 elapsed ticks",
            "tick": 430529,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          }
        },
        {
          "variant": "destroy(60)",
          "prediction": "measure current-pin behavior; no behavior assumed",
          "setup": {
            "success": true,
            "read": {
              "label": "before",
              "tick": 430568,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 37
            },
            "index": 37
          },
          "immediate": {
            "success": true,
            "call_ok": true,
            "call_error": "nil",
            "read": {
              "label": "same execution",
              "tick": 430611,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 37
            }
          },
          "after1": {
            "label": "first observed elapsed read",
            "tick": 430656,
            "game_paused": false,
            "valid": true,
            "platform_count": 3,
            "index": 37
          },
          "after61": {
            "label": "~61 elapsed ticks",
            "tick": 430767,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          },
          "after120": {
            "label": "~120 elapsed ticks",
            "tick": 430877,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          }
        }
      ]
    },
    "b8": {
      "success": true,
      "prediction": "immediate update with and without power",
      "powered": {
        "success": true,
        "powered": true,
        "prediction": "crafting_speed updates in the module-population execution, without requiring power",
        "setup": {
          "success": true,
          "name": "engine-repin-lab-b8-powered-1783663799959",
          "read": {
            "label": "before module",
            "tick": 430918,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 1.25,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 0
          }
        },
        "same_execution": {
          "success": true,
          "inserted": 2,
          "read": {
            "label": "same execution after populate",
            "tick": 430995,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "1",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "next_read": {
          "success": true,
          "read": {
            "label": "first elapsed read",
            "tick": 431043,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "1",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "changed_same_execution": true
      },
      "unpowered": {
        "success": true,
        "powered": false,
        "prediction": "crafting_speed updates in the module-population execution, without requiring power",
        "setup": {
          "success": true,
          "name": "engine-repin-lab-b8-unpowered-1783663802567",
          "read": {
            "label": "before module",
            "tick": 431082,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 1.25,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 0
          }
        },
        "same_execution": {
          "success": true,
          "inserted": 2,
          "read": {
            "label": "same execution after populate",
            "tick": 431126,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "next_read": {
          "success": true,
          "read": {
            "label": "first elapsed read",
            "tick": 431173,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "changed_same_execution": true
      }
    },
    "b9": {
      "success": true,
      "tick": 431260,
      "game_paused": false,
      "remote_success": true,
      "errors": {},
      "warnings": {},
      "physical_iron_plate": 10,
      "unknown_prototype_exists": false,
      "warning_log_before": 2,
      "warning_log_after": 3,
      "warning_logged": true,
      "prediction": "unknown item is skipped with warning while valid contents restore physically"
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 429618,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 374554,
        "force_count": 3
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 429719,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 374651,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 429796,
      "base": "2.0.77"
    },
    "destination": {
      "success": true,
      "tick": 374729,
      "base": "2.0.77"
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "platform-2",
          "engine-repin-lab-b8-powered-1783663799959",
          "engine-repin-lab-b8-unpowered-1783663802567",
          "engine-repin-lab-b9-1783663804609"
        ],
        "tick": 431312,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 376248,
        "force_count": 3
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 431413,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 376345,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T06:10:08.979Z"
}
```


## 2026-07-10T06:12:17.156Z - LAB-I B7-B9 engine re-pin

Predictions were recorded before execution: B7 open; B8 immediate/no-power; B9 graceful skip plus warning.

```json
{
  "script": "tests/engine-repin-lab/run-b7-b9.mjs",
  "started": "2026-07-10T06:11:47.402Z",
  "sections": [
    "b7",
    "b8",
    "b9"
  ],
  "predictions": {
    "b7": "open re-pin",
    "b8": "same-execution crafting_speed update without power dependency",
    "b9": "unknown item skips with warning"
  },
  "rungs": {
    "b7": {
      "success": true,
      "prediction": "open re-pin measurement",
      "variants": [
        {
          "variant": "destroy()",
          "prediction": "measure current-pin behavior; no behavior assumed",
          "setup": {
            "success": true,
            "read": {
              "label": "before",
              "tick": 435832,
              "game_paused": false,
              "valid": true,
              "platform_count": 2,
              "index": 40
            },
            "index": 40
          },
          "immediate": {
            "success": true,
            "call_ok": true,
            "call_error": "nil",
            "read": {
              "label": "same execution",
              "tick": 435874,
              "game_paused": false,
              "valid": true,
              "platform_count": 2,
              "index": 40
            }
          },
          "after1": {
            "label": "first observed elapsed read",
            "tick": 435919,
            "game_paused": false,
            "valid": true,
            "platform_count": 2,
            "index": 40
          },
          "after61": {
            "label": "~61 elapsed ticks",
            "tick": 436033,
            "game_paused": false,
            "valid": true,
            "platform_count": 2,
            "index": 40
          },
          "after120": {
            "label": "~120 elapsed ticks",
            "tick": 436143,
            "game_paused": false,
            "valid": true,
            "platform_count": 2,
            "index": 40
          }
        },
        {
          "variant": "destroy(0)",
          "prediction": "measure current-pin behavior; no behavior assumed",
          "setup": {
            "success": true,
            "read": {
              "label": "before",
              "tick": 436182,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 41
            },
            "index": 41
          },
          "immediate": {
            "success": true,
            "call_ok": true,
            "call_error": "nil",
            "read": {
              "label": "same execution",
              "tick": 436224,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 41
            }
          },
          "after1": {
            "label": "first observed elapsed read",
            "tick": 436270,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          },
          "after61": {
            "label": "~61 elapsed ticks",
            "tick": 436381,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          },
          "after120": {
            "label": "~120 elapsed ticks",
            "tick": 436490,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          }
        },
        {
          "variant": "destroy(60)",
          "prediction": "measure current-pin behavior; no behavior assumed",
          "setup": {
            "success": true,
            "read": {
              "label": "before",
              "tick": 436530,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 42
            },
            "index": 42
          },
          "immediate": {
            "success": true,
            "call_ok": true,
            "call_error": "nil",
            "read": {
              "label": "same execution",
              "tick": 436572,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 42
            }
          },
          "after1": {
            "label": "first observed elapsed read",
            "tick": 436617,
            "game_paused": false,
            "valid": true,
            "platform_count": 3,
            "index": 42
          },
          "after61": {
            "label": "~61 elapsed ticks",
            "tick": 436726,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          },
          "after120": {
            "label": "~120 elapsed ticks",
            "tick": 436836,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          }
        }
      ]
    },
    "b8": {
      "success": true,
      "prediction": "immediate update with and without power",
      "powered": {
        "success": true,
        "powered": true,
        "prediction": "crafting_speed updates in the module-population execution, without requiring power",
        "setup": {
          "success": true,
          "name": "engine-repin-lab-b8-powered-1783663928067",
          "read": {
            "label": "before module",
            "tick": 436876,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 1.25,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 0
          }
        },
        "same_execution": {
          "success": true,
          "inserted": 2,
          "read": {
            "label": "same execution after populate",
            "tick": 436950,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "1",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "next_read": {
          "success": true,
          "read": {
            "label": "first elapsed read",
            "tick": 436998,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "1",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "changed_same_execution": true
      },
      "unpowered": {
        "success": true,
        "powered": false,
        "prediction": "crafting_speed updates in the module-population execution, without requiring power",
        "setup": {
          "success": true,
          "name": "engine-repin-lab-b8-unpowered-1783663930586",
          "read": {
            "label": "before module",
            "tick": 437037,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 1.25,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 0
          }
        },
        "same_execution": {
          "success": true,
          "inserted": 2,
          "read": {
            "label": "same execution after populate",
            "tick": 437082,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "next_read": {
          "success": true,
          "read": {
            "label": "first elapsed read",
            "tick": 437129,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "changed_same_execution": true
      }
    },
    "b9": {
      "success": true,
      "tick": 437220,
      "game_paused": false,
      "remote_success": true,
      "errors": {},
      "warnings": {},
      "physical_iron_plate": 10,
      "unknown_prototype_exists": false,
      "warning_log_before": 3,
      "warning_log_after": 4,
      "warning_logged": true,
      "prediction": "unknown item is skipped with warning while valid contents restore physically"
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 435563,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 382705,
        "force_count": 3
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 435666,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 382807,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 435751,
      "base": "2.0.77"
    },
    "destination": {
      "success": true,
      "tick": 382891,
      "base": "2.0.77"
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "platform-2",
          "engine-repin-lab-b8-powered-1783663928067",
          "engine-repin-lab-b8-unpowered-1783663930586",
          "engine-repin-lab-b9-1783663932634"
        ],
        "tick": 437275,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 384416,
        "force_count": 3
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 437377,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 384517,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T06:12:17.156Z"
}
```


## 2026-07-10T06:20:33.202Z - LAB-I B7-B9 engine re-pin

Predictions were recorded before execution: B7 open; B8 immediate/no-power; B9 graceful skip plus warning.

```json
{
  "script": "tests/engine-repin-lab/run-b7-b9.mjs",
  "started": "2026-07-10T06:20:10.144Z",
  "sections": [
    "b7",
    "b8",
    "b9"
  ],
  "predictions": {
    "b7": "open re-pin",
    "b8": "same-execution crafting_speed update without power dependency",
    "b9": "unknown item skips with warning"
  },
  "rungs": {
    "b7": {
      "success": true,
      "prediction": "open re-pin measurement",
      "variants": [
        {
          "variant": "destroy()",
          "prediction": "measure current-pin behavior; no behavior assumed",
          "setup": {
            "success": true,
            "read": {
              "label": "before",
              "tick": 467839,
              "game_paused": false,
              "valid": true,
              "platform_count": 2,
              "index": 46
            },
            "index": 46
          },
          "immediate": {
            "success": true,
            "call_ok": true,
            "call_error": "nil",
            "start_tick": 467881,
            "read": {
              "label": "same execution",
              "tick": 467881,
              "game_paused": false,
              "valid": true,
              "platform_count": 2,
              "index": 46
            }
          },
          "after1": {
            "label": "+1",
            "tick": 467882,
            "game_paused": false,
            "valid": true,
            "platform_count": 2,
            "index": 46
          },
          "after61": {
            "label": "+61",
            "tick": 467942,
            "game_paused": false,
            "valid": true,
            "platform_count": 2,
            "index": 46
          },
          "after120": {
            "label": "+120",
            "tick": 468001,
            "game_paused": false,
            "valid": true,
            "platform_count": 2,
            "index": 46
          }
        },
        {
          "variant": "destroy(0)",
          "prediction": "measure current-pin behavior; no behavior assumed",
          "setup": {
            "success": true,
            "read": {
              "label": "before",
              "tick": 468056,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 47
            },
            "index": 47
          },
          "immediate": {
            "success": true,
            "call_ok": true,
            "call_error": "nil",
            "start_tick": 468100,
            "read": {
              "label": "same execution",
              "tick": 468100,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 47
            }
          },
          "after1": {
            "label": "+1",
            "tick": 468101,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          },
          "after61": {
            "label": "+61",
            "tick": 468161,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          },
          "after120": {
            "label": "+120",
            "tick": 468220,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          }
        },
        {
          "variant": "destroy(60)",
          "prediction": "measure current-pin behavior; no behavior assumed",
          "setup": {
            "success": true,
            "read": {
              "label": "before",
              "tick": 468274,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 48
            },
            "index": 48
          },
          "immediate": {
            "success": true,
            "call_ok": true,
            "call_error": "nil",
            "start_tick": 468316,
            "read": {
              "label": "same execution",
              "tick": 468316,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 48
            }
          },
          "after1": {
            "label": "+1",
            "tick": 468317,
            "game_paused": false,
            "valid": true,
            "platform_count": 3,
            "index": 48
          },
          "after61": {
            "label": "+61",
            "tick": 468377,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          },
          "after120": {
            "label": "+120",
            "tick": 468436,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          }
        }
      ]
    },
    "b8": {
      "success": true,
      "prediction": "immediate update with and without power",
      "powered": {
        "success": true,
        "powered": true,
        "prediction": "crafting_speed updates in the module-population execution, without requiring power",
        "setup": {
          "success": true,
          "name": "engine-repin-lab-b8-powered-1783664424353",
          "read": {
            "label": "before module",
            "tick": 468488,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 1.25,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 0
          }
        },
        "same_execution": {
          "success": true,
          "inserted": 2,
          "read": {
            "label": "same execution after populate",
            "tick": 468560,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "1",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "next_read": {
          "success": true,
          "read": {
            "label": "first elapsed read",
            "tick": 468605,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "1",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "changed_same_execution": true
      },
      "unpowered": {
        "success": true,
        "powered": false,
        "prediction": "crafting_speed updates in the module-population execution, without requiring power",
        "setup": {
          "success": true,
          "name": "engine-repin-lab-b8-unpowered-1783664426786",
          "read": {
            "label": "before module",
            "tick": 468646,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 1.25,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 0
          }
        },
        "same_execution": {
          "success": true,
          "inserted": 2,
          "read": {
            "label": "same execution after populate",
            "tick": 468689,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "next_read": {
          "success": true,
          "read": {
            "label": "first elapsed read",
            "tick": 468736,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "changed_same_execution": true
      }
    },
    "b9": {
      "success": true,
      "tick": 468822,
      "game_paused": false,
      "remote_success": true,
      "errors": {},
      "warnings": {},
      "physical_iron_plate": 10,
      "unknown_prototype_exists": false,
      "warning_log_before": 4,
      "warning_log_after": 5,
      "warning_logged": true,
      "prediction": "unknown item is skipped with warning while valid contents restore physically"
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 467584,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 414724,
        "force_count": 3
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 467683,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 414822,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 467762,
      "base": "2.0.77"
    },
    "destination": {
      "success": true,
      "tick": 414901,
      "base": "2.0.77"
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "platform-2",
          "engine-repin-lab-b8-powered-1783664424353",
          "engine-repin-lab-b8-unpowered-1783664426786",
          "engine-repin-lab-b9-1783664428843"
        ],
        "tick": 468876,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 416014,
        "force_count": 3
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 468974,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 416113,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T06:20:33.202Z"
}
```


## 2026-07-10T06:20:56.667Z - LAB-I B7-B9 engine re-pin

Predictions were recorded before execution: B7 open; B8 immediate/no-power; B9 graceful skip plus warning.

```json
{
  "script": "tests/engine-repin-lab/run-b7-b9.mjs",
  "started": "2026-07-10T06:20:33.257Z",
  "sections": [
    "b7",
    "b8",
    "b9"
  ],
  "predictions": {
    "b7": "open re-pin",
    "b8": "same-execution crafting_speed update without power dependency",
    "b9": "unknown item skips with warning"
  },
  "rungs": {
    "b7": {
      "success": true,
      "prediction": "open re-pin measurement",
      "variants": [
        {
          "variant": "destroy()",
          "prediction": "measure current-pin behavior; no behavior assumed",
          "setup": {
            "success": true,
            "read": {
              "label": "before",
              "tick": 469309,
              "game_paused": false,
              "valid": true,
              "platform_count": 2,
              "index": 49
            },
            "index": 49
          },
          "immediate": {
            "success": true,
            "call_ok": true,
            "call_error": "nil",
            "start_tick": 469351,
            "read": {
              "label": "same execution",
              "tick": 469351,
              "game_paused": false,
              "valid": true,
              "platform_count": 2,
              "index": 49
            }
          },
          "after1": {
            "label": "+1",
            "tick": 469352,
            "game_paused": false,
            "valid": true,
            "platform_count": 2,
            "index": 49
          },
          "after61": {
            "label": "+61",
            "tick": 469412,
            "game_paused": false,
            "valid": true,
            "platform_count": 2,
            "index": 49
          },
          "after120": {
            "label": "+120",
            "tick": 469471,
            "game_paused": false,
            "valid": true,
            "platform_count": 2,
            "index": 49
          }
        },
        {
          "variant": "destroy(0)",
          "prediction": "measure current-pin behavior; no behavior assumed",
          "setup": {
            "success": true,
            "read": {
              "label": "before",
              "tick": 469527,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 50
            },
            "index": 50
          },
          "immediate": {
            "success": true,
            "call_ok": true,
            "call_error": "nil",
            "start_tick": 469568,
            "read": {
              "label": "same execution",
              "tick": 469568,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 50
            }
          },
          "after1": {
            "label": "+1",
            "tick": 469569,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          },
          "after61": {
            "label": "+61",
            "tick": 469629,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          },
          "after120": {
            "label": "+120",
            "tick": 469688,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          }
        },
        {
          "variant": "destroy(60)",
          "prediction": "measure current-pin behavior; no behavior assumed",
          "setup": {
            "success": true,
            "read": {
              "label": "before",
              "tick": 469746,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 51
            },
            "index": 51
          },
          "immediate": {
            "success": true,
            "call_ok": true,
            "call_error": "nil",
            "start_tick": 469786,
            "read": {
              "label": "same execution",
              "tick": 469786,
              "game_paused": false,
              "valid": true,
              "platform_count": 3,
              "index": 51
            }
          },
          "after1": {
            "label": "+1",
            "tick": 469787,
            "game_paused": false,
            "valid": true,
            "platform_count": 3,
            "index": 51
          },
          "after61": {
            "label": "+61",
            "tick": 469847,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          },
          "after120": {
            "label": "+120",
            "tick": 469906,
            "game_paused": false,
            "valid": false,
            "platform_count": 2
          }
        }
      ]
    },
    "b8": {
      "success": true,
      "prediction": "immediate update with and without power",
      "powered": {
        "success": true,
        "powered": true,
        "prediction": "crafting_speed updates in the module-population execution, without requiring power",
        "setup": {
          "success": true,
          "name": "engine-repin-lab-b8-powered-1783664447466",
          "read": {
            "label": "before module",
            "tick": 469963,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 1.25,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 0
          }
        },
        "same_execution": {
          "success": true,
          "inserted": 2,
          "read": {
            "label": "same execution after populate",
            "tick": 470034,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "1",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "next_read": {
          "success": true,
          "read": {
            "label": "first elapsed read",
            "tick": 470079,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "1",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "changed_same_execution": true
      },
      "unpowered": {
        "success": true,
        "powered": false,
        "prediction": "crafting_speed updates in the module-population execution, without requiring power",
        "setup": {
          "success": true,
          "name": "engine-repin-lab-b8-unpowered-1783664449931",
          "read": {
            "label": "before module",
            "tick": 470119,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 1.25,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 0
          }
        },
        "same_execution": {
          "success": true,
          "inserted": 2,
          "read": {
            "label": "same execution after populate",
            "tick": 470167,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "next_read": {
          "success": true,
          "read": {
            "label": "first elapsed read",
            "tick": 470212,
            "game_paused": false,
            "machine_valid": true,
            "crafting_speed": 3.125,
            "beacon_status": "54",
            "beacon_active": true,
            "module_count": 2
          }
        },
        "changed_same_execution": true
      }
    },
    "b9": {
      "success": true,
      "tick": 470308,
      "game_paused": false,
      "remote_success": true,
      "errors": {},
      "warnings": {},
      "physical_iron_plate": 10,
      "unknown_prototype_exists": false,
      "warning_log_before": 5,
      "warning_log_after": 6,
      "warning_logged": true,
      "prediction": "unknown item is skipped with warning while valid contents restore physically"
    }
  },
  "errors": [],
  "initial_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": {},
        "tick": 469056,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 416196,
        "force_count": 3
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 469154,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 416291,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      }
    },
    "ok": true
  },
  "install": {
    "source": {
      "success": true,
      "tick": 469231,
      "base": "2.0.77"
    },
    "destination": {
      "success": true,
      "tick": 416369,
      "base": "2.0.77"
    }
  },
  "final_reset": {
    "cleanup": {
      "source": {
        "success": true,
        "deleted": [
          "platform-2",
          "engine-repin-lab-b8-powered-1783664447466",
          "engine-repin-lab-b8-unpowered-1783664449931",
          "engine-repin-lab-b9-1783664452020"
        ],
        "tick": 470364,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "deleted": {},
        "tick": 417504,
        "force_count": 3
      }
    },
    "zero": {
      "source": {
        "success": true,
        "tick": 470466,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      },
      "destination": {
        "success": true,
        "tick": 417607,
        "zero_surfaces": true,
        "surfaces": {},
        "zero_storage": true,
        "game_paused": false,
        "destination_holds": 0,
        "locked_platforms": 0,
        "committed_source_transfer_tombstones": 0,
        "lab_platform_exports": 0,
        "force_count": 3
      }
    },
    "ok": true
  },
  "finished": "2026-07-10T06:20:56.667Z"
}
```

## 2026-07-10 - B7 exact-tick correction and definitive evidence

The first two full records (`06:10:08Z`, `06:12:17Z`) sampled B7 through separate RCON calls and therefore
landed tens of ticks after the requested boundaries. Their behavioral direction was correct, but their B7
timing proof is superseded. The runner now wraps the existing `on_tick` handler, calls it on every event, records
the lab snapshots at exactly +1/+61/+120, and restores the original handler automatically at +120.

The definitive consecutive full passes are `06:20:33Z` and `06:20:56Z`. In both, `destroy()` remained valid at
all three exact boundaries, `destroy(0)` was invalid at +1, and `destroy(60)` was valid at +1 and invalid at
+61/+120. Both passes also repeated green B8/B9 evidence and ended with both-instance zero-leftover proof.
