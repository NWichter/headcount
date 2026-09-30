/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/headcount.json`.
 */
export type Headcount = {
  "address": "9NeaXRkbU4Jxsmh2aJyN74gxRoAR7fYupV68FEzDH6KH",
  "metadata": {
    "name": "headcount",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "cancelEvent",
      "docs": [
        "The organizer calls the event off; only before the commit deadline."
      ],
      "discriminator": [
        55,
        143,
        36,
        45,
        59,
        241,
        89,
        119
      ],
      "accounts": [
        {
          "name": "organizer",
          "signer": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "checkIn",
      "docs": [
        "Deposit events: manual check-in by the organizer (fallback without a phone)."
      ],
      "discriminator": [
        209,
        253,
        4,
        217,
        250,
        241,
        207,
        50
      ],
      "accounts": [
        {
          "name": "organizer",
          "signer": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "writable": true,
          "relations": [
            "commitment"
          ]
        },
        {
          "name": "commitment",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "commitment.participant",
                "account": "commitment"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "event"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "participantToken",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "checkInWithPass",
      "docs": [
        "Self check-in with the door pass. The previous instruction must be the",
        "Ed25519 check of the pass by the door key."
      ],
      "discriminator": [
        31,
        58,
        203,
        69,
        120,
        185,
        246,
        113
      ],
      "accounts": [
        {
          "name": "participant",
          "signer": true,
          "relations": [
            "commitment"
          ]
        },
        {
          "name": "event",
          "writable": true,
          "relations": [
            "commitment"
          ]
        },
        {
          "name": "commitment",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "participant"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "event"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "participantToken",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "expiresAt",
          "type": "i64"
        }
      ]
    },
    {
      "name": "closeCommitment",
      "docs": [
        "After a settled event, close a commitment and return its rent. Permissionless."
      ],
      "discriminator": [
        159,
        80,
        4,
        54,
        45,
        135,
        38,
        128
      ],
      "accounts": [
        {
          "name": "event",
          "relations": [
            "commitment"
          ]
        },
        {
          "name": "commitment",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "commitment.participant",
                "account": "commitment"
              }
            ]
          }
        },
        {
          "name": "rentPayer",
          "writable": true,
          "relations": [
            "commitment"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "closeEvent",
      "docs": [
        "NO-GO or cancelled and every refund taken: the organizer closes the event",
        "and its vault. In a refundable event only refunds empty the vault, so an",
        "empty vault means no commitment or pledge account is left."
      ],
      "discriminator": [
        117,
        114,
        193,
        54,
        49,
        25,
        75,
        194
      ],
      "accounts": [
        {
          "name": "organizer",
          "writable": true,
          "signer": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "event"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "closePledge",
      "docs": [
        "After a settled event, close a pledge and return its rent to its payer."
      ],
      "discriminator": [
        84,
        63,
        119,
        56,
        166,
        189,
        166,
        246
      ],
      "accounts": [
        {
          "name": "event",
          "relations": [
            "pledge"
          ]
        },
        {
          "name": "pledge",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  101,
                  100,
                  103,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "pledge.backer",
                "account": "pledge"
              }
            ]
          }
        },
        {
          "name": "rentPayer",
          "writable": true,
          "relations": [
            "pledge"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "commit",
      "docs": [
        "Pay the ticket price or deposit into the event's vault. Once per person."
      ],
      "discriminator": [
        223,
        140,
        142,
        165,
        229,
        208,
        156,
        74
      ],
      "accounts": [
        {
          "name": "participant",
          "signer": true
        },
        {
          "name": "payer",
          "docs": [
            "Pays fees and account rent: the participant, or the app on their behalf."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "event",
          "writable": true
        },
        {
          "name": "commitment",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "participant"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "event"
          ]
        },
        {
          "name": "participantToken",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "createEvent",
      "discriminator": [
        49,
        219,
        29,
        203,
        22,
        98,
        100,
        87
      ],
      "accounts": [
        {
          "name": "organizer",
          "writable": true,
          "signer": true
        },
        {
          "name": "event",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  118,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "organizer"
              },
              {
                "kind": "arg",
                "path": "eventId"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Classic SPL Token only: Token-2022 fees, hooks or delegates could drain the vault."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "eventId",
          "type": "u64"
        },
        {
          "name": "kind",
          "type": {
            "defined": {
              "name": "eventKind"
            }
          }
        },
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "minParticipants",
          "type": "u32"
        },
        {
          "name": "maxParticipants",
          "type": "u32"
        },
        {
          "name": "minAmount",
          "type": "u64"
        },
        {
          "name": "commitDeadline",
          "type": "i64"
        },
        {
          "name": "eventEnd",
          "type": "i64"
        },
        {
          "name": "doorKey",
          "type": "pubkey"
        },
        {
          "name": "title",
          "type": "string"
        }
      ]
    },
    {
      "name": "pledge",
      "docs": [
        "Ticket events: back the event without a seat; counts toward the budget only."
      ],
      "discriminator": [
        235,
        47,
        156,
        254,
        0,
        88,
        212,
        142
      ],
      "accounts": [
        {
          "name": "backer",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "event",
          "writable": true
        },
        {
          "name": "pledge",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  101,
                  100,
                  103,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "backer"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "event"
          ]
        },
        {
          "name": "backerToken",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "refund",
      "docs": [
        "Refund on NO-GO, cancellation, or a deposit event nobody checked in to."
      ],
      "discriminator": [
        2,
        96,
        183,
        251,
        63,
        208,
        46,
        46
      ],
      "accounts": [
        {
          "name": "participant",
          "docs": [
            "trigger a refund, and the tokens can only reach this owner's token account."
          ],
          "relations": [
            "commitment"
          ]
        },
        {
          "name": "event",
          "relations": [
            "commitment"
          ]
        },
        {
          "name": "commitment",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "participant"
              }
            ]
          }
        },
        {
          "name": "rentPayer",
          "writable": true,
          "relations": [
            "commitment"
          ]
        },
        {
          "name": "mint",
          "relations": [
            "event"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "participantToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "participant"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "refundPledge",
      "docs": [
        "Backers get their pledge back under the same rules as participants."
      ],
      "discriminator": [
        94,
        154,
        65,
        172,
        38,
        217,
        41,
        206
      ],
      "accounts": [
        {
          "name": "backer",
          "relations": [
            "pledge"
          ]
        },
        {
          "name": "event",
          "relations": [
            "pledge"
          ]
        },
        {
          "name": "pledge",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  101,
                  100,
                  103,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "backer"
              }
            ]
          }
        },
        {
          "name": "rentPayer",
          "writable": true,
          "relations": [
            "pledge"
          ]
        },
        {
          "name": "mint",
          "relations": [
            "event"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "backerToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "backer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "setDoorKey",
      "docs": [
        "Register or rotate the door screen key that signs check-in passes."
      ],
      "discriminator": [
        254,
        101,
        122,
        194,
        223,
        117,
        60,
        111
      ],
      "accounts": [
        {
          "name": "organizer",
          "signer": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "doorKey",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "sweep",
      "docs": [
        "Deposit events: after the event the no-shows' deposits go to the organizer."
      ],
      "discriminator": [
        40,
        23,
        234,
        175,
        14,
        61,
        154,
        177
      ],
      "accounts": [
        {
          "name": "organizer",
          "signer": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "event"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "organizerToken",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "treasury",
          "address": "jSVWkBaMrzx6Vwxg3kLnjm4ACTLux2nFqmHLghrQF3B"
        },
        {
          "name": "treasuryToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "treasury"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        }
      ],
      "args": []
    },
    {
      "name": "withdraw",
      "docs": [
        "Ticket events: once GO and past the deadline, the organizer takes the vault."
      ],
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "organizer",
          "signer": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "event"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "organizerToken",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "treasury",
          "address": "jSVWkBaMrzx6Vwxg3kLnjm4ACTLux2nFqmHLghrQF3B"
        },
        {
          "name": "treasuryToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "treasury"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "commitment",
      "discriminator": [
        61,
        112,
        129,
        128,
        24,
        147,
        77,
        87
      ]
    },
    {
      "name": "event",
      "discriminator": [
        125,
        192,
        125,
        158,
        9,
        115,
        152,
        233
      ]
    },
    {
      "name": "pledge",
      "discriminator": [
        161,
        197,
        121,
        46,
        99,
        75,
        169,
        131
      ]
    }
  ],
  "events": [
    {
      "name": "cancelled",
      "discriminator": [
        136,
        23,
        42,
        65,
        143,
        233,
        234,
        46
      ]
    },
    {
      "name": "checkedIn",
      "discriminator": [
        211,
        80,
        198,
        244,
        196,
        84,
        212,
        150
      ]
    },
    {
      "name": "committed",
      "discriminator": [
        70,
        158,
        162,
        86,
        29,
        111,
        143,
        226
      ]
    },
    {
      "name": "doorKeySet",
      "discriminator": [
        75,
        235,
        28,
        227,
        232,
        245,
        155,
        170
      ]
    },
    {
      "name": "eventCreated",
      "discriminator": [
        59,
        186,
        199,
        175,
        242,
        25,
        238,
        94
      ]
    },
    {
      "name": "pledged",
      "discriminator": [
        98,
        154,
        68,
        227,
        24,
        48,
        26,
        16
      ]
    },
    {
      "name": "refunded",
      "discriminator": [
        35,
        103,
        149,
        246,
        196,
        123,
        221,
        99
      ]
    },
    {
      "name": "swept",
      "discriminator": [
        254,
        138,
        9,
        198,
        192,
        61,
        165,
        135
      ]
    },
    {
      "name": "withdrawn",
      "discriminator": [
        20,
        89,
        223,
        198,
        194,
        124,
        219,
        13
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidPrice",
      "msg": "Price must be greater than zero"
    },
    {
      "code": 6001,
      "name": "invalidLimits",
      "msg": "Minimum must be at least 1 and not above the maximum"
    },
    {
      "code": 6002,
      "name": "invalidDeadline",
      "msg": "Deadline must be in the future and not after the event end"
    },
    {
      "code": 6003,
      "name": "invalidTitle",
      "msg": "Title must be 1 to 64 bytes"
    },
    {
      "code": 6004,
      "name": "deadlinePassed",
      "msg": "The commit deadline has passed"
    },
    {
      "code": 6005,
      "name": "deadlineNotReached",
      "msg": "The deadline has not been reached yet"
    },
    {
      "code": 6006,
      "name": "eventFull",
      "msg": "The event is full"
    },
    {
      "code": 6007,
      "name": "wrongKind",
      "msg": "Wrong event kind for this action"
    },
    {
      "code": 6008,
      "name": "notGo",
      "msg": "The event has not reached its minimum (not GO)"
    },
    {
      "code": 6009,
      "name": "eventIsGo",
      "msg": "The event reached its minimum (GO); no refunds"
    },
    {
      "code": 6010,
      "name": "nothingToWithdraw",
      "msg": "The vault is empty"
    },
    {
      "code": 6011,
      "name": "eventOver",
      "msg": "The event is over"
    },
    {
      "code": 6012,
      "name": "eventNotOver",
      "msg": "The event is not over yet"
    },
    {
      "code": 6013,
      "name": "alreadyCheckedIn",
      "msg": "Already checked in"
    },
    {
      "code": 6014,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6015,
      "name": "cancelled",
      "msg": "The event was cancelled"
    },
    {
      "code": 6016,
      "name": "alreadyPaidOut",
      "msg": "Money was already paid out or people checked in; cannot cancel"
    },
    {
      "code": 6017,
      "name": "nobodyCheckedIn",
      "msg": "Nobody was checked in; participants take their deposits back instead"
    },
    {
      "code": 6018,
      "name": "unsupportedMint",
      "msg": "Only classic SPL Token mints such as USDC are supported"
    },
    {
      "code": 6019,
      "name": "cancelTooLate",
      "msg": "The commit deadline has passed; the event can no longer be cancelled"
    },
    {
      "code": 6020,
      "name": "checkInNotOpen",
      "msg": "Check-in opens at the commit deadline"
    },
    {
      "code": 6021,
      "name": "budgetOnlyForTickets",
      "msg": "A budget goal is only possible for ticket events"
    },
    {
      "code": 6022,
      "name": "noDoorScreen",
      "msg": "This event has no door screen yet; ask the organizer"
    },
    {
      "code": 6023,
      "name": "invalidPass",
      "msg": "This door pass is not valid for this event"
    },
    {
      "code": 6024,
      "name": "passExpired",
      "msg": "This door pass has expired; scan the current one"
    },
    {
      "code": 6025,
      "name": "stillRefundable",
      "msg": "Refunds are still possible for this event; the account stays open"
    },
    {
      "code": 6026,
      "name": "wrongTreasury",
      "msg": "This is not the protocol treasury"
    },
    {
      "code": 6027,
      "name": "vaultNotEmpty",
      "msg": "The vault still holds tokens; refunds are not all taken yet"
    }
  ],
  "types": [
    {
      "name": "cancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "event",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "checkedIn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "event",
            "type": "pubkey"
          },
          {
            "name": "participant",
            "type": "pubkey"
          },
          {
            "name": "checkedIn",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "commitment",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "event",
            "type": "pubkey"
          },
          {
            "name": "participant",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "checkedIn",
            "type": "bool"
          },
          {
            "name": "rentPayer",
            "docs": [
              "Gets the rent back on close (the participant or a sponsoring app)."
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "committed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "event",
            "type": "pubkey"
          },
          {
            "name": "participant",
            "type": "pubkey"
          },
          {
            "name": "participants",
            "type": "u32"
          },
          {
            "name": "minParticipants",
            "type": "u32"
          },
          {
            "name": "wentGo",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "doorKeySet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "event",
            "type": "pubkey"
          },
          {
            "name": "doorKey",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "event",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "organizer",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "eventId",
            "type": "u64"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "eventKind"
              }
            }
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "minParticipants",
            "type": "u32"
          },
          {
            "name": "maxParticipants",
            "type": "u32"
          },
          {
            "name": "participants",
            "type": "u32"
          },
          {
            "name": "checkedIn",
            "type": "u32"
          },
          {
            "name": "minAmount",
            "docs": [
              "Budget goal for tickets + pledges (0 = none)."
            ],
            "type": "u64"
          },
          {
            "name": "totalCommitted",
            "docs": [
              "Tickets plus pledges; never decreases before the outcome."
            ],
            "type": "u64"
          },
          {
            "name": "pledged",
            "type": "u64"
          },
          {
            "name": "backers",
            "type": "u32"
          },
          {
            "name": "commitDeadline",
            "type": "i64"
          },
          {
            "name": "eventEnd",
            "type": "i64"
          },
          {
            "name": "withdrawn",
            "type": "u64"
          },
          {
            "name": "cancelled",
            "type": "bool"
          },
          {
            "name": "doorKey",
            "docs": [
              "Signs door passes (default = no door screen yet)."
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "title",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "eventCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "event",
            "type": "pubkey"
          },
          {
            "name": "organizer",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "eventKind"
              }
            }
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "minParticipants",
            "type": "u32"
          },
          {
            "name": "minAmount",
            "type": "u64"
          },
          {
            "name": "commitDeadline",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "eventKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "ticket"
          },
          {
            "name": "deposit"
          }
        ]
      }
    },
    {
      "name": "pledge",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "event",
            "type": "pubkey"
          },
          {
            "name": "backer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "rentPayer",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "pledged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "event",
            "type": "pubkey"
          },
          {
            "name": "backer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "wentGo",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "refunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "event",
            "type": "pubkey"
          },
          {
            "name": "participant",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "swept",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "event",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "noShows",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "withdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "event",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
