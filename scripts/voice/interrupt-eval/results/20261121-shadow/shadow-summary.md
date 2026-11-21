
### stops: the decision to stop the assistant

| decider | n | decision within 300 ms of the onset | within 700 ms | median decision (ms) | decided before the person spoke |
| --- | --- | --- | --- | --- | --- |
| baseline (the call) | 20 | 1/20 (1%-24%) silent within 350 ms | 4/20 (8%-42%) silent | 752 (silence) | 1 |
| pilot (the call) | 20 | 17/20 (64%-95%) silent within 350 ms | 17/20 (64%-95%) silent | 146 (silence) | 0 |
| detector, card, threshold 0.5 | 20 | 20/20 (84%-100%) | 20/20 (84%-100%) | 40 | 7 |
| detector, card, threshold 0.7 | 20 | 18/20 (70%-97%) | 19/20 (76%-99%) | 80 | 6 |
| detector, card, threshold 0.9 | 20 | 2/20 (3%-30%) | 5/20 (11%-47%) | 320 | 2 |
| detector, stop0, threshold 0.5 | 20 | 14/20 (48%-85%) | 17/20 (64%-95%) | 120 | 3 |
| detector, stop0, threshold 0.7 | 20 | 6/20 (15%-52%) | 11/20 (34%-74%) | 280 | 0 |
| detector, stop0, threshold 0.9 | 20 | 0/20 (0%-16%) | 1/20 (1%-24%) | 320 | 0 |
| detector, zeros, threshold 0.5 | 20 | 20/20 (84%-100%) | 20/20 (84%-100%) | 40 | 9 |
| detector, zeros, threshold 0.7 | 20 | 17/20 (64%-95%) | 17/20 (64%-95%) | 40 | 9 |
| detector, zeros, threshold 0.9 | 20 | 1/20 (1%-24%) | 2/20 (3%-30%) | 320 | 1 |

### corrections: the decision to stop the assistant

| decider | n | decision within 300 ms of the onset | within 700 ms | median decision (ms) | decided before the person spoke |
| --- | --- | --- | --- | --- | --- |
| baseline (the call) | 20 | 3/20 (5%-36%) silent within 350 ms | 9/20 (26%-66%) silent | 715 (silence) | 1 |
| pilot (the call) | 20 | 20/20 (84%-100%) silent within 350 ms | 20/20 (84%-100%) silent | 143 (silence) | 0 |
| detector, card, threshold 0.5 | 20 | 20/20 (84%-100%) | 20/20 (84%-100%) | 40 | 8 |
| detector, card, threshold 0.7 | 20 | 20/20 (84%-100%) | 20/20 (84%-100%) | 80 | 8 |
| detector, card, threshold 0.9 | 20 | 8/20 (22%-61%) | 8/20 (22%-61%) | 200 | 0 |
| detector, stop0, threshold 0.5 | 20 | 19/20 (76%-99%) | 20/20 (84%-100%) | 120 | 1 |
| detector, stop0, threshold 0.7 | 20 | 14/20 (48%-85%) | 20/20 (84%-100%) | 120 | 0 |
| detector, stop0, threshold 0.9 | 20 | 8/20 (22%-61%) | 9/20 (26%-66%) | 240 | 0 |
| detector, zeros, threshold 0.5 | 20 | 20/20 (84%-100%) | 20/20 (84%-100%) | 40 | 11 |
| detector, zeros, threshold 0.7 | 20 | 19/20 (76%-99%) | 20/20 (84%-100%) | 120 | 8 |
| detector, zeros, threshold 0.9 | 20 | 6/20 (15%-52%) | 8/20 (22%-61%) | 440 | 0 |

### the sounds that were not for the assistant: a decision to stop it where there should be none

| decider | all controls | backchannel | cough | echo |
| --- | --- | --- | --- | --- |
| baseline (the call): reply cut off or a turn made | 13/20 (43%-82%) | 10/10 | 1/5 | 2/5 |
| pilot (the call): reply cut off or a turn made | 1/20 (1%-24%) | 1/10 | 0/5 | 0/5 |
| detector, card, threshold 0.5 | 20/20 (84%-100%) | 10/10 | 5/5 | 5/5 |
| detector, card, threshold 0.7 | 19/20 (76%-99%) | 9/10 | 5/5 | 5/5 |
| detector, card, threshold 0.9 | 2/20 (3%-30%) | 2/10 | 0/5 | 0/5 |
| detector, stop0, threshold 0.5 | 12/20 (39%-78%) | 6/10 | 4/5 | 2/5 |
| detector, stop0, threshold 0.7 | 5/20 (11%-47%) | 4/10 | 1/5 | 0/5 |
| detector, stop0, threshold 0.9 | 0/20 (0%-16%) | 0/10 | 0/5 | 0/5 |
| detector, zeros, threshold 0.5 | 19/20 (76%-99%) | 9/10 | 5/5 | 5/5 |
| detector, zeros, threshold 0.7 | 16/20 (58%-92%) | 8/10 | 3/5 | 5/5 |
| detector, zeros, threshold 0.9 | 1/20 (1%-24%) | 1/10 | 0/5 | 0/5 |
