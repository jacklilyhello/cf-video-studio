# 人工用量接口退役 / Manual usage retirement

[项目首页](../README.md) · [中文](#中文) · [English](#english) · [自动资源用量](resource-usage.md)

## 中文

人工抄录 Cloudflare 用量、账期、核对时间和证据 ID 的流程已经取消，不作为日常上传或处理前置条件。使用[自动资源用量](resource-usage.md#中文)查看项目官方观测、当前记录、估算及缺口，无需从 Cloudflare 回填数据。

历史人工记录和上传批准保留审计；未使用的旧上传许可退役并释放许可预留，活动 multipart 仍保留自己的预留和取消核实保护。旧未执行人工处理报价必须重新生成，按新方案逐任务确认。

管理员鉴权后的旧 `GET/POST /api/admin/usage/manual` 返回 `410 manual_usage_retired`；旧上传批准接口同样退役。大小、项目空间、已知不足、处理预算、逐任务确认及停止监督仍生效。退休人工接口不意味着开放未知费用下的付费执行。

## English

Manual transcription of Cloudflare usage, billing periods, review times and evidence IDs is retired. It is not an everyday upload or processing requirement. [Automatic resource usage](resource-usage.md#english) shows project-scoped official observations, current records, estimates and gaps, without forms to fill after visiting Cloudflare.

Historical manual records/upload approvals remain audit-only. Unused legacy upload permissions are retired and release their approval reservations; active multipart uploads retain independent reservations and verified cancellation. Old unused manual processing quotes must be regenerated and explicitly confirmed for the new exact scope.

After administrator authentication, legacy `GET/POST /api/admin/usage/manual` returns `410 manual_usage_retired`; upload approvals are also retired. Size, project capacity, known shortages, processing budgets, per-task confirmation and stop supervision remain enforced. Retirement does not enable paid execution with unknown usage.
