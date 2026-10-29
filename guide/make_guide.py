"""PDF-гайд: как поднять своего ИИ-ассистента для Instagram из публичных шаблонов."""
import sys
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle)

F = "/usr/share/fonts/truetype/dejavu/"
pdfmetrics.registerFont(TTFont("Sans", F + "DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("Sans-Bold", F + "DejaVuSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("Sans-It", F + "DejaVuSans-Oblique.ttf"))
pdfmetrics.registerFont(TTFont("Mono", F + "DejaVuSansMono.ttf"))
from reportlab.pdfbase.pdfmetrics import registerFontFamily
registerFontFamily("Sans", normal="Sans", bold="Sans-Bold", italic="Sans-It", boldItalic="Sans-Bold")

ORG = "skoomaholic-art"
BOT_TPL = f"https://github.com/{ORG}/assistant-bot-template"
ENG_TPL = f"https://github.com/{ORG}/insta-engine-template"

INK, MUTED, ACCENT, SOFT, LINE = colors.HexColor("#14181d"), colors.HexColor("#5b6670"), colors.HexColor("#d9822b"), colors.HexColor("#fbf3e8"), colors.HexColor("#e3ded6")
WARN_BG, OK_BG = colors.HexColor("#fdecea"), colors.HexColor("#eaf6ee")

ST = {
    "title": ParagraphStyle("title", fontName="Sans-Bold", fontSize=26, leading=31, textColor=INK, spaceAfter=10),
    "sub": ParagraphStyle("sub", fontName="Sans", fontSize=12.5, leading=18, textColor=MUTED, spaceAfter=18),
    "h1": ParagraphStyle("h1", fontName="Sans-Bold", fontSize=17, leading=22, textColor=INK, spaceBefore=6, spaceAfter=8),
    "h2": ParagraphStyle("h2", fontName="Sans-Bold", fontSize=12.5, leading=17, textColor=INK, spaceBefore=10, spaceAfter=5),
    "p": ParagraphStyle("p", fontName="Sans", fontSize=10, leading=15, textColor=INK, spaceAfter=6),
    "li": ParagraphStyle("li", fontName="Sans", fontSize=10, leading=15, textColor=INK, leftIndent=14, bulletIndent=3, spaceAfter=3),
    "small": ParagraphStyle("small", fontName="Sans", fontSize=8.5, leading=12, textColor=MUTED),
    "cell": ParagraphStyle("cell", fontName="Sans", fontSize=8.6, leading=12, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName="Sans-Bold", fontSize=8.6, leading=12, textColor=INK),
    "code": ParagraphStyle("code", fontName="Mono", fontSize=8.8, leading=12.5, textColor=INK, backColor=colors.HexColor("#f3f1ee"), borderPadding=(5, 6, 5, 6), spaceBefore=3, spaceAfter=8),
}


def P(t, s="p"): return Paragraph(t, ST[s])
def link(url, text=None): return f'<link href="{url}" color="#b5651d"><u>{text or url}</u></link>'
def code(t): return Paragraph(t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br/>"), ST["code"])
def bullets(items, numbered=False):
    return [Paragraph(x, ST["li"], bulletText=(f"{i}." if numbered else "•")) for i, x in enumerate(items, 1)]


def box(title, lines, bg=SOFT, edge=ACCENT):
    body = [P(f"<b>{title}</b>", "p")] + [P(x, "p") for x in lines]
    t = Table([[body]], colWidths=[170 * mm])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), bg), ("LINEBEFORE", (0, 0), (0, -1), 3, edge),
                           ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                           ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    return KeepTogether([t, Spacer(1, 8)])


def table(rows, widths, head=True):
    data = [[Paragraph(c, ST["cellb" if (head and r == 0) else "cell"]) for c in row] for r, row in enumerate(rows)]
    t = Table(data, colWidths=[w * mm for w in widths], repeatRows=1 if head else 0)
    style = [("GRID", (0, 0), (-1, -1), 0.5, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
             ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]
    if head: style.append(("BACKGROUND", (0, 0), (-1, 0), SOFT))
    t.setStyle(TableStyle(style))
    return t


def step(n, title):
    t = Table([[Paragraph(f"<font color='white'><b>{n}</b></font>", ParagraphStyle("n", fontName="Sans-Bold", fontSize=13, alignment=1, leading=16)), P(f"<b>{title}</b>", "h1")]],
              colWidths=[11 * mm, 159 * mm])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (0, 0), ACCENT), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (1, 0), (1, 0), 8)]))
    return t


def footer(c, doc):
    c.saveState(); c.setFont("Sans", 8); c.setFillColor(MUTED)
    c.drawString(20 * mm, 12 * mm, "Instagram Manager · гайд по установке")
    c.drawRightString(190 * mm, 12 * mm, str(doc.page)); c.restoreState()


def build(out):
    s = []
    s += [Spacer(1, 30 * mm), P("Instagram Manager: свой ИИ-помощник для Instagram", "title"),
          P("Пошаговая установка: Telegram-бот, мини-приложение, конструктор обложек, ИИ-редактор, автопубликация и аналитика. Бесплатно, без программирования", "sub")]
    s.append(box("Что получится в конце", [
        "• Telegram-бот, который отвечает только тебе, и мини-приложение <b>Instagram Manager</b> прямо в Telegram",
        "• ИИ пишет посты, карусели и Reels по новостям кино и сериалов, ты согласовываешь текст и финал",
        "• Конструктор обложек, поиск кадров по фильмам и актёрам, живые Reels с музыкой",
        "• Робот сам публикует в Instagram (только после двух твоих «ок»), собирает статистику и учится на твоих правках"]))
    s.append(table([["Сколько времени", "Сколько стоит", "Что нужно уметь"],
                    ["1,5–2 часа в первый раз", "0 ₸: всё на бесплатных тарифах", "Копировать и вставлять. Код писать не нужно"]], [57, 57, 56]))
    s.append(Spacer(1, 10))
    s.append(box("Как читать гайд", ["Иди по шагам по порядку. Все ключи, которые ты получаешь, сразу записывай в заметки на телефоне: они понадобятся на следующих шагах. "
                                     "Никому их не показывай и не отправляй в чаты: по ключу можно управлять твоим ботом или аккаунтом"], WARN_BG, colors.HexColor("#d9534f")))
    s.append(PageBreak())

    s += [P("Как это устроено", "h1"),
          P("Четыре части, у каждой своя роль:"),
          table([["Часть", "Где живёт", "Что делает"],
                 ["Telegram-бот и мини-приложение", "Vercel (бесплатный хостинг), из твоей копии <b>assistant-bot</b>", "Карточки на согласование, кнопки, конструктор, аналитика, новости"],
                 ["Движок и данные", "GitHub, твоя приватная копия <b>insta-engine</b>", "Хранит посты и статистику, «робот» собирает картинки и видео и публикует"],
                 ["Instagram", "Твой профессиональный аккаунт + приложение Meta", "Публикация и статистика через официальный интерфейс"],
                 ["ИИ", "Groq (бесплатный ключ)", "Пишет тексты, выбирает темы, учится на правках"]], [45, 60, 65]),
          Spacer(1, 8),
          P("Путь поста: новость → ИИ пишет текст → карточка в боте → «Текст ок» → робот на GitHub собирает картинки в конструкторе → финал в боте → «Публиковать» → Instagram → статистика через 24 ч, 72 ч и 7 дней"),
          P("Что понадобится", "h2")]
    s += bullets([
        "Telegram на телефоне",
        "Instagram-аккаунт, переведённый в <b>профессиональный</b> (Автор или Бизнес): Настройки → Тип аккаунта и инструменты → Переключиться на профессиональный",
        f"Аккаунт GitHub: {link('https://github.com/signup')}",
        f"Аккаунт Vercel (входи через GitHub): {link('https://vercel.com/signup')}",
        f"Аккаунт Meta for Developers (входи через Facebook): {link('https://developers.facebook.com')}",
        f"Ключ Groq для ИИ: {link('https://console.groq.com/keys')}",
        f"Необязательно: TMDB (поиск кадров) {link('https://www.themoviedb.org/settings/api')}, fanart.tv {link('https://fanart.tv/get-an-api-key/')}, Gemini (проверка фактов) {link('https://aistudio.google.com/apikey')}"])
    s.append(PageBreak())

    s += [step(1, "Создай Telegram-бота"), Spacer(1, 6)]
    s += bullets([f"Открой {link('https://t.me/BotFather', '@BotFather')} и отправь <b>/newbot</b>",
                  "Придумай <b>имя</b> (видно в чатах, можно на русском и с пробелами) и <b>username</b>: латиница, без пробелов, в конце обязательно <b>bot</b>, например <i>mycinema_assistant_bot</i>",
                  "BotFather пришлёт <b>токен</b> вида <font name='Mono'>1234567890:AAH…</font>. Это <b>TG_BOT_TOKEN</b>, сохрани его",
                  f"Узнай свой числовой Telegram ID: напиши {link('https://t.me/userinfobot', '@userinfobot')}, он ответит числом. Это <b>TG_OWNER_CHAT_ID</b>: только этот ID сможет управлять ботом"], True)
    s += [P("Оформи бота (по желанию, 3 минуты)", "h2"),
          P("Всё делается там же, в @BotFather: отправь команду, выбери своего бота и пришли то, что он просит")]
    s.append(table([["Команда", "Что делает", "Пример"],
                    ["/setuserpic", "Аватарка бота (квадратная картинка)", "логотип или иконка"],
                    ["/setdescription", "Текст, который человек видит до нажатия «Старт»", "«Мой ИИ-помощник для Instagram»"],
                    ["/setabouttext", "Короткое описание в профиле бота", "«Посты, Reels и аналитика»"],
                    ["/setcommands", "Меню команд. Можно пропустить: бот сам добавит меню на шаге 6", "post - пост из темы"],
                    ["/setjoingroups", "Запретить добавлять бота в группы", "Disable (рекомендую)"],
                    ["/mybots", "Список ботов: токен, настройки, мини-приложение", "—"]], [32, 78, 60]))
    s.append(Spacer(1, 6))
    s.append(box("Если на этом шаге что-то пошло не так", ['Видишь «Sorry, this username is already taken»? Имя занято. Добавь цифры или слово: <i>mycinema_2_bot</i>, в конце всё равно bot', 'Потерял токен? @BotFather → /mybots → твой бот → API Token. Если токен засветился в чате или на скриншоте, нажми там же <b>Revoke current token</b> и вставь новый на Vercel (шаг 5)']))

    s += [step(2, "Скопируй код из шаблонов"), Spacer(1, 6),
          P("Код лежит в двух открытых шаблонах. Ты делаешь из них <b>свои приватные</b> копии: в них будут твои посты, и никто кроме тебя их не увидит")]
    s += bullets([f"Открой шаблон бота: {link(BOT_TPL)}",
                  "Нажми зелёную кнопку <b>Use this template → Create a new repository</b>",
                  "Owner: твой аккаунт. Repository name: <b>assistant-bot</b>. Видимость: <b>Private</b>. Нажми <b>Create repository</b>",
                  f"То же для движка: {link(ENG_TPL)} → имя <b>insta-engine</b>, тоже <b>Private</b>",
                  "Запиши: <b>IGM_REPOSITORY</b> = <font name='Mono'>твой-логин/insta-engine</font>"], True)
    s.append(box("Если на этом шаге что-то пошло не так", ['Нет кнопки «Use this template»? Скорее всего ты не вошёл в GitHub. Войди и обнови страницу', 'Случайно создал Public? Settings → внизу Danger Zone → Change visibility → Private. Иначе все увидят твои посты и статистику']))

    s += [step(3, "Ключ GitHub для связи бота с движком"), Spacer(1, 6),
          P("Бот хранит посты в репозитории insta-engine, поэтому ему нужен ключ с доступом только к нему")]
    s += bullets([f"Открой {link('https://github.com/settings/personal-access-tokens/new')} (Settings → Developer settings → Fine-grained tokens → Generate new token)",
                  "Token name: <i>assistant-bridge</i>. Expiration: 1 год (или No expiration, если доступно)",
                  "Repository access: <b>Only select repositories</b> → выбери только <b>insta-engine</b>",
                  "Permissions → Repository permissions → <b>Contents: Read and write</b>. Остальное не трогай",
                  "Generate token и скопируй ключ (начинается с <font name='Mono'>github_pat_</font>). Это <b>IGM_BRIDGE_TOKEN</b>, GitHub покажет его один раз"], True)
    s.append(box("Если на этом шаге что-то пошло не так", ['Бот пишет «нет доступа к IGM», «404» или «Bad credentials»? Скорее всего в ключе не выбран репозиторий insta-engine или не выдано <b>Contents: Read and write</b>. Сделай новый ключ по шагам выше и замени IGM_BRIDGE_TOKEN на Vercel', 'Всё работало, а потом посты перестали сохраняться? Истёк срок ключа. Создай новый и замени']))

    s += [step(4, "Придумай три секретных пароля"), Spacer(1, 6),
          P("Это внутренние пароли между частями системы. Любые случайные строки от 32 символов, <b>без пробелов</b>. Проще всего сгенерировать:"),
          P(f"{link('https://www.random.org/strings/?num=3&len=20&digits=on&upperalpha=on&loweralpha=on&unique=on&format=html&rnd=new', 'random.org: 3 строки по 20 символов')} и склей по две строки в одну, или придумай сам"),
          table([["Название", "Зачем"], ["TG_WEBHOOK_SECRET", "Telegram доказывает боту, что сообщение настоящее"],
                 ["PIPELINE_SECRET", "Робот на GitHub и бот на Vercel узнают друг друга. <b>Одинаковый</b> в обоих местах"],
                 ["CRON_SECRET", "Защищает ежедневный запуск ИИ-редактора"]], [55, 115])]
    s.append(box("Если на этом шаге что-то пошло не так", ['Сборка на Vercel падает с <b>INVALID_CRON_SECRET</b>? При копировании (особенно с телефона) в пароль попал пробел или перенос строки. Вставь значение заново, без пробелов', 'Не понимаешь, где взять TG_WEBHOOK_SECRET? Его не выдаёт ни Telegram, ни Vercel: ты придумываешь его сам. Это не токен бота']))
    s.append(PageBreak())

    s += [step(5, "Запусти бота на Vercel"), Spacer(1, 6)]
    s += bullets([f"Открой {link('https://vercel.com/new')} → <b>Import</b> напротив репозитория <b>assistant-bot</b> (если его нет в списке: Adjust GitHub App Permissions и разреши доступ)",
                  "Framework Preset: <b>Other</b>. Ничего больше не меняй",
                  "Раскрой <b>Environment Variables</b> и добавь переменные из таблицы ниже. У каждой включи <b>Sensitive</b>",
                  "Нажми <b>Deploy</b>. Через минуту получишь адрес вида <font name='Mono'>assistant-bot-xxx.vercel.app</font>: это адрес твоего мини-приложения"], True)
    s.append(table([["Переменная", "Значение", "Обязательно"],
                    ["TG_BOT_TOKEN", "токен из шага 1", "да"], ["TG_OWNER_CHAT_ID", "твой числовой ID из шага 1", "да"],
                    ["TG_WEBHOOK_SECRET", "пароль из шага 4", "да"], ["IGM_BRIDGE_TOKEN", "ключ github_pat_ из шага 3", "да"],
                    ["IGM_REPOSITORY", "твой-логин/insta-engine", "да"], ["PIPELINE_SECRET", "пароль из шага 4", "да"],
                    ["CRON_SECRET", "пароль из шага 4", "да"], ["GROQ_API_KEY", f"ключ с {link('https://console.groq.com/keys', 'console.groq.com/keys')} (начинается с gsk_)", "да, для ИИ"],
                    ["WEBAPP_HOST", "адрес приложения без https://, например assistant-bot-xxx.vercel.app", "желательно"],
                    ["TMDB_API_KEY", "API Key или Read Access Token с themoviedb.org", "для поиска кадров"],
                    ["FANART_API_KEY", "personal API key с fanart.tv", "нет"], ["GEMINI_API_KEY", "ключ Google AI Studio", "для проверки фактов"],
                    ], [48, 92, 30]))
    s.append(Spacer(1, 6))
    s.append(box("После любого изменения переменных", ["Vercel применяет их только к новой сборке: Deployments → у последней сборки ⋯ → <b>Redeploy</b>"]))
    s.append(box("Если на этом шаге что-то пошло не так", ['Vercel пишет <b>Deployment Blocked</b> про автора коммита? Бесплатный тариф собирает только коммиты, у которых автор совпадает с владельцем аккаунта Vercel. Скорее всего коммит сделан от другого имени или почты. Сделай коммит из своего GitHub (веб-редактор, клавиша «.») и проверь, что Vercel подключён к тому же GitHub', '<b>Build Failed</b>? Открой лог сборки: внизу обычно название переменной, с которой проблема (пробел, пустое значение)', 'Бот пишет «Groq отклонил ключ»? Ключ скопировался не полностью или его удалили. Создай новый на console.groq.com/keys, вставь и сделай Redeploy', 'Поменял переменную, а ничего не изменилось? Vercel применяет переменные только после <b>Redeploy</b>']))
    s.append(PageBreak())

    s += [step(6, "Подключи бота к Telegram"), Spacer(1, 6)]
    s += bullets(["Открой в браузере адрес (подставь свой домен и пароль TG_WEBHOOK_SECRET):"], True)
    s.append(code("https://ТВОЙ-ДОМЕН.vercel.app/api/bot?install=ТВОЙ_TG_WEBHOOK_SECRET"))
    s += bullets(["Должно появиться «Готово»: бот подключён, у него появилась кнопка меню «Instagram Manager»",
                  "Напиши боту <b>/start</b>. Он ответит и покажет кнопку мини-приложения",
                  "Чтобы ставить иконку на экран телефона: @BotFather → /mybots → бот → <b>Bot Settings → Configure Mini App → Enable Mini App</b> → отправь адрес https://ТВОЙ-ДОМЕН.vercel.app. "
                  "Потом открой приложение и в меню ⋯ выбери «Добавить на экран «Домой»»"])
    s.append(box("Если на этом шаге что-то пошло не так", ['Видишь «Неверный ключ установки»? В адресе не тот пароль. Частая ошибка: вставляют токен бота вместо своего TG_WEBHOOK_SECRET', 'Бот молчит на /start? Проверь по очереди: открыт ли адрес установки из этого шага; твой ли ID в TG_OWNER_CHAT_ID (бот отвечает только владельцу); был ли Redeploy после добавления переменных', 'Нет пункта «Добавить на экран «Домой»»? Не включено мини-приложение бота: @BotFather → /mybots → бот → Bot Settings → Configure Mini App → Enable Mini App']))

    s += [step(7, "Подключи Instagram через Meta"), Spacer(1, 6),
          P("Используется официальный интерфейс Instagram API с входом через Instagram. Facebook-страница для этого способа не нужна")]
    s += bullets([f"Открой {link('https://developers.facebook.com/apps')} → <b>Create App</b>",
                  "Use case: <b>Manage messaging &amp; content on Instagram</b> (Instagram API). Тип: Business. Название любое",
                  "В приложении открой <b>Instagram → API setup with Instagram login</b>",
                  "В разделе <b>Generate access tokens</b> нажми <b>Add account</b> и войди в свой Instagram (профессиональный)",
                  "Выдай разрешения: <b>instagram_business_basic</b>, <b>instagram_business_content_publish</b>, <b>instagram_business_manage_insights</b>, при желании <b>instagram_business_manage_comments</b>",
                  "Нажми <b>Generate token</b> и скопируй его: это <b>IG_ACCESS_TOKEN</b>. Там же указан числовой <b>Instagram user ID</b>: это <b>IG_USER_ID</b>"], True)
    s.append(box("Важно про токен", ["Токен живёт около 60 дней. За неделю до конца сгенерируй новый там же и замени секрет IG_ACCESS_TOKEN в GitHub (шаг 8). "
                                     "Поставь себе напоминание в календаре"], WARN_BG, colors.HexColor("#d9534f")))
    s.append(box("Если на этом шаге что-то пошло не так", ['Нет кнопки <b>Add account</b>? Instagram ещё не профессиональный. Переключи тип аккаунта в приложении Instagram и повтори', 'Ошибка <b>(#10)</b> или <b>(#200)</b> про permission? При генерации токена не отмечено нужное разрешение. Сгенерируй токен заново со всеми галочками. Все разрешения, включая статистику (insights), бесплатные', 'Ошибка <b>190</b> / «токен недействителен»? Истёк срок (около 60 дней) или сменился пароль Instagram. Сгенерируй новый токен и обнови IG_ACCESS_TOKEN']))

    s += [step(8, "Настрой робота в insta-engine"), Spacer(1, 6),
          P("Открой свой репозиторий insta-engine → <b>Settings → Secrets and variables → Actions</b>")]
    s.append(table([["Вкладка", "Имя", "Значение"],
                    ["Secrets", "IG_ACCESS_TOKEN", "токен Instagram из шага 7"], ["Secrets", "IG_USER_ID", "Instagram user ID из шага 7"],
                    ["Secrets", "PIPELINE_SECRET", "тот же пароль, что на Vercel"], ["Secrets", "TG_BOT_TOKEN", "токен бота"],
                    ["Secrets", "TG_OWNER_CHAT_ID", "твой Telegram ID"], ["Variables", "PIPELINE_BASE_URL", "https://ТВОЙ-ДОМЕН.vercel.app"],
                    ["Variables", "IG_EXPECTED_USERNAME", "логин Instagram без @ (защита от публикации не в тот аккаунт)"],
                    ["Variables", "IGM_ENABLE_PUBLISH", "<b>true</b>, когда будешь готов к автопубликации. До этого не добавляй"]], [24, 48, 98]))
    s.append(Spacer(1, 6))
    s += bullets(["Открой вкладку <b>Actions</b>. Если GitHub спрашивает, включи workflows кнопкой <b>I understand… enable them</b>",
                  "Запусти один раз <b>Music library for Reels</b> (Run workflow): робот скачает бесплатную музыку для Reels",
                  "Запусти <b>Viral Lab</b> и <b>Instagram Manager</b> вручную, чтобы проверить, что токен Instagram работает (зелёная галочка)"], True)
    s.append(box("Если на этом шаге что-то пошло не так", ['Красный крестик и «Vercel отклонил подпись»? PIPELINE_SECRET в GitHub и на Vercel отличаются. Вставь одинаковый в оба места, на Vercel сделай Redeploy', 'Видишь «Публикация выключена: IGM_ENABLE_PUBLISH»? Это защита от случайной публикации. Добавь переменную IGM_ENABLE_PUBLISH = true, когда будешь готов', 'Ошибка «ffmpeg is not available» при сборке Reels? На серверах GitHub сменилась система. В шаблоне это уже исправлено: обнови файлы из папки .github/workflows', 'Viral Lab (статистика) с красным крестиком? Почти всегда дело в токене Instagram: истёк или выдан без instagram_business_manage_insights', 'Расписание не запускается? В новом репозитории запусти каждый workflow один раз вручную (Run workflow)']))

    s += [step(9, "Проверь, что всё работает"), Spacer(1, 6)]
    s += bullets(["В боте отправь <b>/status</b>: бот покажет, какие ключи найдены, и что не так",
                  "Открой мини-приложение → <b>Новости</b> → у любой новости нажми <b>«Пост»</b>: ИИ посоветует формат и пришлёт текст в бот",
                  "Нажми <b>«Текст ок»</b>: через 2–3 минуты придёт финал с картинками",
                  "Для первого раза нажми <b>«Опубликую сам»</b>: робот пришлёт файлы, ничего не публикуя. Если всё нравится, в следующий раз жми «Публиковать»"], True)
    s.append(box("Если на этом шаге что-то пошло не так", [
        "Финал не приходит дольше 10 минут? Открой insta-engine → Actions → Post Pipeline → красный запуск: текст ошибки внизу. Чаще всего это PIPELINE_SECRET или токен Instagram",
        "Отправил картинку, а бот сделал из неё отдельный пост? Картинку для поста ИИ присылай <b>ответом</b> на карточку этого поста (свайп влево по сообщению). Или нажми «Это обложка для …» под карточкой своего фото",
        "«ИИ вернул слишком мало слайдов» или «ИИ не ответил»? Бесплатный ИИ иногда сбивается: нажми «Другой вариант». При ошибке 429 подожди минуту, это лимит бесплатного тарифа",
        "Нажал кнопку в конструкторе и непонятно, сработало ли? Смотри цветную плашку под кнопками: синяя — идёт работа, зелёная — готово, красная — ошибка с подсказкой"]))

    s += [P("Сделай бренд своим", "h1")]
    s += bullets(["В шаблонах вместо названия стоит <b>MyBrand</b>. Открой свой репозиторий на GitHub и нажми клавишу <b>.</b> (точку): откроется редактор в браузере",
                  "Нажми Ctrl+Shift+H (поиск и замена во всех файлах): замени <b>MyBrand</b> на своё название, <b>MYBRAND</b> на то же заглавными и <b>mybrand</b> на логин Instagram",
                  "Слева во вкладке Source Control напиши «бренд» и нажми Commit &amp; Push. Сделай так в обоих репозиториях",
                  "Логотип: открой конструктор в мини-приложении → «Логотип и сетка» → загрузи свой"])
    s.append(PageBreak())

    s += [P("Если что-то не работает", "h1"),
          table([["Что видишь", "Почему", "Что сделать"],
                 ["Бот не отвечает совсем", "Не подключён вебхук или упала сборка", "Шаг 6 заново. На Vercel проверь, что последняя сборка Ready"],
                 ["«Владелец не настроен»", "Нет TG_OWNER_CHAT_ID", "Добавь ID на Vercel, Redeploy"],
                 ["«Доступ только у владельца»", "ID не совпадает с твоим", "Узнай ID у @userinfobot заново"],
                 ["«ИИ не ответил» / 429", "Нет ключа Groq или исчерпан бесплатный лимит", "Проверь GROQ_API_KEY. При 429 подожди минуту"],
                 ["Финал не приходит больше 10 минут", "Робот на GitHub упал", "insta-engine → Actions → Post Pipeline → открой красный запуск, текст ошибки внизу"],
                 ["«Vercel отклонил подпись»", "Разные PIPELINE_SECRET", "Сделай одинаковым в GitHub и Vercel, Redeploy"],
                 ["«Публикация выключена»", "Нет IGM_ENABLE_PUBLISH=true", "Добавь переменную в insta-engine"],
                 ["Ошибка Instagram (#10), (#200)", "Нет разрешения у токена", "Шаг 7: новый токен со всеми разрешениями"],
                 ["Ошибка Instagram 190", "Истёк токен", "Сгенерируй новый, обнови IG_ACCESS_TOKEN"],
                 ["«ffmpeg is not available»", "На сервере GitHub нет видеопрограммы", "Обнови файлы workflows из шаблона: там установка ffmpeg"],
                 ["Поиск кадров: «нет TMDB_API_KEY»", "Ключ не задан", "Получи ключ на themoviedb.org, добавь на Vercel, Redeploy"],
                 ["Deployment Blocked", "Автор коммита не владелец Vercel", "Коммить из своего GitHub, проверь подключение Vercel к GitHub"]], [52, 52, 66]),
          Spacer(1, 6), P("Безопасность", "h2")]
    s += bullets(["Бот отвечает только твоему Telegram ID. Посторонние видят лишь приветствие и этот гайд",
                  "Ничего не публикуется без двух твоих согласований: текст и финал",
                  "Ключи храни только в Vercel и GitHub Secrets. Не присылай их в чаты, не публикуй на скриншотах",
                  "Включи двухэтапную проверку в Telegram, двухфакторную защиту в GitHub, Vercel и Meta",
                  "Репозитории держи приватными: в них твои посты и статистика"])
    s += [P("Сколько это стоит", "h2"),
          P("Vercel Hobby, GitHub (около 2000 минут работы робота в месяц для приватных репозиториев), Groq, TMDB, Meta API: бесплатно. "
            "При 3 постах в день и паре Reels робот тратит примерно 300–600 минут в месяц. Музыка для Reels: треки Kevin MacLeod (CC BY 4.0), автор указывается в подписи автоматически. "
            "Кадры из фильмов принадлежат правообладателям: робот ставит их только после твоего подтверждения")]
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=15 * mm, bottomMargin=17 * mm,
                            title="Instagram Manager: гайд по установке", author="")
    doc.build(s, onFirstPage=footer, onLaterPages=footer)


build(sys.argv[1])
