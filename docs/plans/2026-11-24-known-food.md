# Visit remembered food Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let empty-handed hungry agents use their own known food before searching locally.

**Architecture:** Mirror gather_resource: first attempt with positive-confidence food uses existing travel_to(resource),harvest_resource,eat. Actual harvest verifies world mutation and corrects exhausted beliefs. Carried food remains first;unknown/depleted records and later attempts retain current discovery/exploration.

**Tech Stack:** TypeScript,existingNode22/24node:test,FakeEnvironment,SQLiteledger;no dependencies orpaidreasoning.

---

1. Add test/goals/known-food.test.ts:assertfirstattemptknownfoodplan,carriedpriority,zero-confidence/nonfoodfallback,laterattemptfreshground andfakeenvironmenttravel/verifiedharvest/eat. Confirmnewroutingtestsfailbeforeimplementation.
2. Editonly src/goals/planner.ts find_food branch tocallnearestKnown onfirstattempt andskipredundantlocaldiscovery whenknown. Nevercreateknowledge/resources orreadotheragents.
3. Run npmtest/typecheck/build onNode24.11.1;documentboundedflowindocs/results.md preservinghistoricalsoaknumbers/fullrotationTODO. Scanexplicitstagedpaths;commit,mergemain,pushandverifySHA. ActualmainCI mustrunfullsuiteonNode22/24.
4. Updateportfolioqueue/profile/inventory/receipt andselectiveLore;preserveownerindexes andreleaseownlock.
