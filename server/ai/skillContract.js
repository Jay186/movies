import { assetNameRule, characterCoverageRule, integratedModulesRule } from './storyboardRules.js'
import { shotTypeTermsText } from './shotTypes.js'

// 平台输出契约（Skill 规则 ↔ 平台 JSON 之间的适配层）
// 原则：方法论 100% 服从 xiaomo-film-studio Skill 规则（由调用方注入规则全文）；
//       本契约只规定「平台生产管线要求的输出格式」与「H3 模型物理边界」。
//       Skill 模板与契约冲突处（时长/输出字段），一律以本契约为准。

// 空间类型判定表（Skill §9 原表，供资产提取侧判定用）
// 必须随资产契约注入：asset-rules.md 只讲「室内/室外/半室外」，
// S1-S4/O1/O2/X 代号表在 storyboard-rules.md §9 —— 不注入定义，模型会把 S 当成"尺寸档"乱贴。
export function buildSpaceTypeTable() {
  return `【空间类型判定表（Skill §9，S=室内 / O=室外，代号判错会导致分镜景别上限与运镜禁令整场失效）】
- S1 室内封闭小空间：≤20㎡、层高≤2.8m（景别上限全景，禁鸟瞰/升降）
- S2 室内中型空间：20-60㎡、层高≤3m（景别上限全景，禁鸟瞰/升降）
- S3 室内大型空间：60-200㎡、层高3-6m（景别上限远景）
- S4 室内超大型空间：>200㎡、层高>6m（景别上限大远景，可鸟瞰/升降）
- O1 室外开阔场景：无遮挡、视野开阔（上限大远景，可鸟瞰/升降）
- O2 室外半封闭/狭窄：有围墙、建筑夹持、崖壁夹持、巷道等（上限远景）
- X 特殊封闭场景：极端狭窄（上限中全景，禁横移/拉镜/升降/环绕）
判定顺序：先判室内还是室外（有顶、有墙、有门窗的封闭空间=室内；露天的街道/河滩/山崖/森林=室外），再按面积体量取对应档。露天场景绝不可判成 S 开头。
【O1 与 O2 的区分（最易判错，必须逐条自检）】看"视线与通行的受限程度"，不看面积大小：
- O1 = 无遮挡、视野开阔、通行自由：开阔河滩/湖面/开阔林间空地/山巅平台/广场——四周没有把视线或通道夹住的东西。
- O2 = 有夹持或半封闭：崖壁夹持的窄道、两侧有围墙/建筑的巷道、头顶树冠+两侧密林夹出的林道、岩体围出的凹处、半敞口的廊下/院落。
【自检闭环】写完 spaceEvidence 后回读一遍：若 evidence 里出现「夹持/夹住/狭窄/只容…通过/有遮挡/半封闭/两侧是墙/头顶有岩壁」等字眼，代号必须是 O2（极端狭窄才是 X），绝不能是 O1；反之 O1 的 evidence 里不得出现"半封闭/遮挡"字样。代号与 evidence 自相矛盾 = 判错。
【判定示例（照此口径）】
- 「两侧高墙夹持的窄巷，只容一人侧身通过」→ O2（两侧被夹持、通行受限）
- 「谷底开阔碎石滩，一眼望到河边」→ O1（无遮挡、通行自由）
- 「林间空地，四周树木稀疏」→ O1；「两侧密林夹出的林道，头顶树冠相接」→ O2（树冠与密林夹持）
- 「岩体围出的背风凹处，头顶和左侧有岩壁」→ O2（半封闭）
- 「空旷湖面 / 山巅平台 / 开阔河心」→ O1
- 「室内客厅约 20㎡」→ S1；「室内议事厅约 120㎡、层高 5m」→ S3
【格式】spaceType 与 spaceEvidence 必须成对出现且彼此自洽；输出前逐个场景再做一次 O1/O2 复核。`
}

// 分镜 JSON 契约：字段清单 + 取值枚举（全部中性中文概念，模型方言翻译在 provider 层）
export function buildStoryboardContract() {
  return `【Skill 文档「不输出」条款的本平台豁免清单（逐条覆盖，优先于 Skill 输出格式章节）】
Skill 规则末尾要求"这些约束内部遵守但不输出"，其中下列项目在本平台【必须输出】——它们是生产管线的字段，缺失即失败：
 ① integratedMultimodalDescription（Skill 称"AI提示词"）——本平台必填，按下方 6 模块规范书写；
 ② duration / startTime / endTime（Skill 称"不计算时长、不标注时长"）——本平台必填（H3 需 4-15 整数秒）；
 ③ lens 焦段、cameraAngle/cameraElevation 机位（Skill 表头字段）——本平台必填，不得留空；
 ④ colorLighting 五层色彩整行、spaceType 空间类型——本平台必填；
 ⑤ purpose / emotionTone / worldStateOut / isCombat——本平台必填（下游校验与出片开关依赖）。
仍然【不输出】的：导演备注、场景预可视化表、全局色调总表、镜头语言总览表、各类自检清单、质感锚点字段、段间总结与前情提要、提示词前缀原文。
【平台 JSON 输出契约 · 每镜字段】（键名严格如下；方法论服从 Skill 规则，格式服从本契约）
- shotType: 景别，取值（Skill §3 档位表）：${shotTypeTermsText()}
- spaceType: 本镜空间类型代号：S1/S2/S3/S4/O1/O2/X【本镜自行判定，判定表见 Skill 规则 §9】——依据本镜场景的空间结构（有无顶棚墙体、被什么夹持、通道宽窄、视野遮挡）判定；资产清单若带空间类型标注，仅作参考，必须以本镜空间结构复核为准（实测资产侧标注不可靠）。同场各镜必须一致；判不出就写该场景最接近的一档，不要留空
- spaceEvidence: 空间判定依据（中文一句话：被什么夹持/面积体量/开敞度，如「两侧高墙夹持的窄巷，只容一人通过，左侧高墙右侧临空」）——与 spaceType 成对输出，不得留空，且彼此自洽（O2 必须写出夹持/狭窄证据；O1 不得出现半封闭/遮挡字样）
- lens: 焦段，格式「类型 mm」：标准 35mm / 中长焦 85mm / 长焦 135mm / 广角 24mm / 超广角 18mm / 微距 100mm（按场景物理与景别选。六档定值为平台工程收窄——Skill §4 原文为焦段区间，定值便于产线枚举映射）
- cameraAngle: 水平机位（Skill §5 方向轴）：正面/侧45度/侧面/过肩/主观（对话与叙事默认侧45度）
- cameraElevation: 俯仰：平视/微俯/俯拍/大俯角/微仰/仰拍/大仰角（纯平视填空字符串；大俯角须场景有真实高点，Skill §9）
- cameraMovement: 运镜方式，Skill 运镜词汇，可复合（如「推镜+微摇」「手持剧烈晃动」；固定镜头全片≤10%）
- startTime/endTime/duration: 整数秒；duration 4-15；首镜 startTime=0，其后每镜 startTime=上一镜 endTime，连续不重叠不留空档
- description: 中文画面内容（3-6 句，信息密度优先于句数）：覆盖画面中所有关键人物的位置与动作并声明视觉中心；非人物镜头写"无人物"并说明承载的情绪/信息；情绪一律用可见动作/微表情外化，禁形容词直给；光影叙事（光源方向/光位/色温/明暗交界线）直接写进本字段（Skill 规则 §1 光源动机 + visual-quality 光/曝光分离）。禁：换行/带冒号小标题/"镜头给到""我们看到"元描述/英文 prompt 词汇（Audio/Visual/Camera 等）
- colorLighting: 色调方案整行，严格按 Skill 模板：{色调方案名}，高光{色值}，阴影{色值}，色温{数值}K。palette={}/saturation={}/film_stock={}/grain={}/halation={}（五层齐全，全片一致，Skill §2）
- actionNote: 镜内时间轴拍点（出片提示词的唯一时间来源），格式「0-2s 保持静止；At 2.0s 动作；末 0.8s 静止无动作」
- dialogue: 台词对象或对象数组 {character, tone, text, startTime}；startTime 用全片绝对秒（可省略）；无台词填 null
- soundEffects: 画内音效（动作音；有音桥标"音桥入/音桥出"）
- overallSoundscape: 环境声与空间氛围
- nonDiegeticMusic: 一律输出空字符串 ""（Skill 规则 §14 全程无背景音乐，硬规则无例外）
- humanVoice: 台词之外的表演性人声（喘息/惊呼/低鸣/啜泣），无则空字符串
- finalFrame: 英文末帧精确描述——每个可见角色的画面侧位（at frame left / at frame right / at center frame）+ 视线锚物（gazes toward ...）+ 道具位置状态 + 光位三件套（方向+色温，如 "cold blue light from frame left"）。这是下一镜画面承接依据，必须与 worldStateOut 一致
- isCombat: 布尔。true=本镜有肢体冲突/物理撞击/打斗/狂暴/追击/破坏等动作对抗（出片加载打斗 LoRA）；false=文戏。只看本镜内容判定
- purpose: 本镜叙事任务一句话（10-30 字），"为什么切这一刀"
- emotionTone: 本镜情绪基调（2-6 字），与情绪曲线位置一致
- worldStateOut: 末帧实体状态快照（中文紧凑格式：@角色=画面位置·手持·朝向；道具=位置·状态），与 finalFrame 完全一致
- transitionIn/transitionOut: 入场/出场转场；有原值时原样保留。按 xiaomo-film-studio 的剪辑语汇填写：场内普通切换可写「切」，只有明确设计了动作/视线/图形匹配或视桥时才写对应的匹配语义；空值仅表示原稿未填写，平台不得据同场、角色、景别或 worldStateIn 自动推断连续承接
- actionNote（规整用户已定稿分镜时适用）：按原稿记录镜内动作和时间顺序；该场景不套用平台自定义的拍点数量或间隔限制。生成新分镜不适用本条，按上方 integratedMultimodalDescription 模块4 执行（单时间戳≤1 主动作、相邻间隔≥1 秒，实测防吞动作）。无 dialogue 时保留原始声音字段，不强制新增静音声明
- integratedMultimodalDescription: 【必填】给 AI **图像**模型使用的完整多模态提示词（英文，用于生成分镜图/首帧/尾帧锚），按下方 6 模块结构书写，每模块 1-2 句、整段不超过 220 词（220 词为平台经验值，官方无此限——防生图提示词冗长稀释控制力的实测口径）。【落点铁律】出片（视频）提示词不读本字段（它按 shotType/description/actionNote/cameraMovement/cameraAngle/finalFrame 重建）——留白与拍点写 actionNote、景深/影调/光质/焦段质感写 description、光位+方向+色温写 finalFrame，只写在本字段里的时间维度内容对出片无效。6 模块规范：
  ${integratedModulesRule()}
- characters/sceneAssets/propAssets: 资产名数组。${assetNameRule()}${characterCoverageRule()}无法确定某个名字是否在清单里时，宁可不列也不要猜`
}

// H3 模型物理边界（官方文档 + 项目实测；属模型说明书，不是分镜美学——换模型时随 provider 走）
export function buildH3PhysicsBlock() {
  return `【H3 物理边界（官方 platform.minimax.io 文档 + 实测，不可违反）】
1. 单镜时长 4-15 整数秒；时长由动作量与台词决定：台词镜开口偏移 + 台词字数÷4.5 + 1 秒余量 ≤ duration；纯动作爆发镜可短至 4-5s，情绪沉淀/连续动作链镜可至 8-15s。
2. 拍点全部写进 actionNote，并按镜内因果顺序排列；同一时间戳不要堆叠互相冲突的主动作。拍点数量由已定稿分镜的表演节奏决定，本契约不按镜头时长规定固定上限。
3. finalFrame 必须纯英文（官方 ref-en 要求六个 section 用英文撰写；「汉字会被当台词念出」为平台实测推断，非官方原文）；description/actionNote 用中文（平台翻译层处理）。
4. 单条出片 prompt 官方上限 7000 字符——description 信息密度优先，不写与画面无关的铺陈。`
}
