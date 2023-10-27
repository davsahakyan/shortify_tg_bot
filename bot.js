const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const mysql = require('mysql');
const cron = require('node-cron');
const fs = require('fs');
require('dotenv').config();

const sanitizeUrl = require("@braintree/sanitize-url").sanitizeUrl;

const bot = new TelegramBot(process.env.TG_TOKEN, { polling: true });

var con = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
});

let lang = 'EN';

con.connect(function (err) {
    if (err) {
        console.error(`SQL CONNECTION ERROR:\n${err.sqlMessage}`);
        process.exitCode = 1;
        throw new Error('SQL CONNECTION ERROR');
    }
});

let fetchURL = (url) => {
    let response;

    return new Promise(async (resolve, reject) => {
        try {
            response = await axios.get(url);
        } catch (error) {
            reject(error)
        }

        if (response) resolve(response)
    })
}

const getLastNQueries = (uid, n) => {
    n = (typeof n == 'undefined' ? 5 : n)
    return new Promise((resolve, reject) => {
        con.query(`SELECT * FROM Links WHERE uid = '${uid}' ORDER BY id DESC LIMIT ${n}`, function (err, result, fields) {
            if (err) reject(err);
            resolve(result);
        })
    })
}

let shortenURL = (url) => {
    return new Promise((resolve, reject) => {
        fetchURL(`http://cutt.ly/api/api.php?key=${process.env.URL_TOKEN}&short=${url}`).then(response => {
            if (response.data.url.status == 7) resolve(response.data.url.shortLink)
            else reject(response.data.url.status)
        })
    })
}

let checkUserSubscription = (uid) => {
    return new Promise((resolve, reject) => {
        con.query(`SELECT * FROM Users WHERE uid = '${uid}'`, function (err, result, fields) {
            if (err) reject(err)
            if (result.length !== 0) {
                resolve([true, true])
            } else {
                con.query(`SELECT * FROM Links WHERE uid = '${uid}'`, function (err, result, fields) {
                    if (err) reject(err)
                    resolve([result.length <= 10, false]);
                })
            }
        })
    })
}

let processUrl = (url) => {
    if (!/^((http|https):\/\/)(.+)/.test(url)) {
        return sanitizeUrl(`https://${url}`);
    }
    return sanitizeUrl(url);
}

let handleShortenRequest = (chatId, msg) => {
    checkUserSubscription(chatId).then(subscribed => {
        if (subscribed[0]) {
            shortenURL(processUrl(msg)).then((shortLink) => {
                con.query(`INSERT INTO Links (uid, url) VALUES ('${chatId}', '${shortLink}');`, function (err, result, fields) {
                    // if (err) throw err;
                    bot.sendMessage(chatId, `${shortLink}${subscribed[1] ? '\n\nThanks for staying pro with us!' : ''}`, {
                        "reply_markup": {
                            inline_keyboard: [[{
                                text: 'Get stats 🤖',
                                callback_data: shortLink
                            }]]
                        },
                    })
                })
            }).catch(e => {
                bot.sendMessage(chatId, `Please enter a link with correct format (e.g. https://google.com)`);
            })
        } else {
            bot.sendMessage(chatId, 'You have shortened all of your 10 free links.\nTo continue shortening, get a <b>life-time</b> subsciption. \nIt costs just <b>3$</b> (a cup of coffee)\n\n/subscribe for details', { parse_mode: "HTML" })
        }
    })
}

bot.onText(/\/start/, (msg, match) => {
    con.query(`SELECT * FROM Users WHERE uid = '${msg.chat.id}'`, function (err, result, fields) {
        if (err) reject(err);
        if (result.length !== 0) {
            if (/[EN|AM|RU]/.test(result[0])) {
                lang = result[0];
            }
        }
        bot.sendMessage(msg.chat.id, `<b>Welcome to URL shortening bot!</b>\n\nCommands list is available below:\n\n/shorten - get a <i>cut.ly</i> link\n/history - get last shortens\n/subscribe - get a <i>life-time</i> pro status\n\nTo change bot's language, use /language`, { parse_mode: "HTML" })
    })
})

bot.onText(/\/shorten$/, (msg, match) => {
    let chatId = msg.chat.id;

    bot.sendMessage(chatId, 'Reply to this message with the link you want to shorten').then(data => {
        bot.onReplyToMessage(chatId, data.message_id, (msg) => {
            handleShortenRequest(chatId, msg.text);
        })
    })
})

bot.onText(/\/shorten (.+)/, (msg, match) => {
    handleShortenRequest(msg.chat.id, match[1]);
})

bot.onText(/\/history$/, (msg, match) => {
    let keyboard = [];
    checkUserSubscription(msg.chat.id).then(subscribed => {
        let reply;

        if (subscribed[1]) {
            reply = `Here are your latest <b>5</b> shortens\n\nTo get stats, click on any of the links\n\nThanks for staying pro with us!`
        } else {
            reply = 'Here are your latest <b>5</b> shortens\n\nTo get stats, click on any of the links\n\nTo get the history of more than <b>5</b> links, you can get a lifetime subscription. \n\n p.s. /subscribe for details'
        }
        getLastNQueries(msg.chat.id).then(results => {
            results.forEach((r, i) => {
                keyboard.push([{ text: `${i + 1}. ${r.url}`, callback_data: r.url }])
            })
            bot.sendMessage(msg.chat.id, reply, {
                reply_markup: {
                    inline_keyboard: keyboard
                },
                parse_mode: "HTML"
            })
        }).catch(e => console.log(e))
    })
})

bot.onText(/\/history [0-9]*$/, (msg, match) => {
    let chatId = msg.chat.id;
    checkUserSubscription(chatId).then(subscribed => {
        let count = parseInt(match[0].split(' ')[1]);
        if (count > 50) {
            bot.sendMessage(chatId, 'Maximum history limit is 50 at the moment. Please contact the administrator for more.')
        } else {
            let keyboard = [];
            getLastNQueries(chatId, count).then(results => {
                results.forEach((r, i) => {
                    keyboard.push([{ text: `${i + 1}. ${r.url}`, callback_data: r.url }])
                })
                bot.sendMessage(chatId, `Here are your latest <b>${count}</b> shortens\n\nTo get stats, click on any of the links\n\nThanks for staying pro with us!`, {
                    reply_markup: {
                        inline_keyboard: keyboard
                    },
                    parse_mode: "HTML"
                })
            })
        }
    })
})

bot.onText(/\/subscribe$/, (msg, match) => {
    checkUserSubscription(msg.chat.id).then(subscribed => {
        bot.sendMessage(msg.chat.id, `${subscribed[1] ? '<i>You are already subscribed</i>\n\n' : ''}By paying <b>1500֏</b>, you get a <b>life-time</b> subcription, with <b>unlimited</b> shortens, <b>unlimited</b> statistics, and history up to <b>50</b> links.\n\nPayments options are:\n\n💳 Card transfer (/card to get payment credentials)\n💸 Idram transfer (/idram to get payment credentials) `, { parse_mode: 'HTML' })
    })
})

bot.onText(/\/card$/, (msg, match) => {
    bot.sendMessage(msg.chat.id, `💳 Card number: 4318290080270362`, { parse_mode: 'HTML' }).then(() => {
        bot.sendMessage(msg.chat.id, `After making the payment, please send the payment check(invoice) here in this chat, admin will validate everything and give you access to pro features`)
    })
})

bot.onText(/\/idram$/, (msg, match) => {
    bot.sendMessage(msg.chat.id, `💸 Idram id: 699325748`, { parse_mode: 'HTML' }).then(() => {
        bot.sendMessage(msg.chat.id, `After making the payment, please send the payment check(invoice) here in this chat, admin will validate everything and give you access to pro features`)
    })
})

bot.onText(/\/language$/, (msg, match) => {
    let chatId = msg.chat.id;

    bot.sendMessage(chatId, 'Select one of the options below: ', {
        reply_markup: {
            inline_keyboard: [[{
                text: 'AM 🇦🇲',
                callback_data: 'LANG-AM'
            }, {
                text: 'RU 🇷🇺',
                callback_data: 'LANG-RU'
            }, {
                text: 'EN 🇬🇧',
                callback_data: 'LANG-EN'
            }]]
        }
    })
})

bot.onText(/\/admin (.+)/, (msg, match) => {
    checkUserSubscription(msg.chat.id).then(s => {
        bot.sendMessage(process.env.ADMIN_TG_ID, `User [uid ${msg.chat.id} | name ${msg.chat.first_name} | subscriber ${s[1]}]\nsent following message\n\n${match[1]}`).then(() => {
            bot.sendMessage(msg.chat.id, `Your message was successfully sent to the administrator. He will respond shortly.`)
        })
    })
})

bot.onText(/\/admin$/, (msg, match) => {
    bot.sendMessage(msg.chat.id, `Correct command is /admin [your-message]`)
})

bot.on("callback_query", (callbackQuery) => {
    let keyboard = callbackQuery.message.reply_markup.inline_keyboard[0][0];
    if (keyboard.text === 'Get stats 🤖') {
        const resp = keyboard.callback_data.split('/');
        fetchURL(`http://cutt.ly/api/api.php?key=${process.env.URL_TOKEN}&stats=${resp[resp.length - 1]}`).then(response => {
            bot.answerCallbackQuery(callbackQuery.id, {
                text: `Stats for /${resp[resp.length - 1]}\n\nCreated at ${response.data.stats.date}\n\n${response.data.stats.clicks} clicks`,
                show_alert: true
            })
        })
    } else if (/https:\/\/cutt.ly\//.test(callbackQuery.data)) {
        const resp = callbackQuery.data.split('/');
        fetchURL(`http://cutt.ly/api/api.php?key=${process.env.URL_TOKEN}&stats=${resp[resp.length - 1]}`).then(response => {
            bot.answerCallbackQuery(callbackQuery.id, {
                text: `Stats for /${resp[resp.length - 1]}\n\nCreated at ${response.data.stats.date}\n\n${response.data.stats.clicks} clicks`,
                show_alert: true
            })
        }).catch(e => {
            if (e.response.status === 429) {
                bot.answerCallbackQuery(callbackQuery.id, {
                    text: `Too many requests, please try again in a minute`,
                })
            }
        })
    } else if (/LANG-/.test(callbackQuery.data)) {
        lang = callbackQuery.data.split('-')[1];
        con.query(`SELECT * FROM Users WHERE uid='${callbackQuery.message.chat.id}'`, function (err, result, fields) {
            if (err) throw err;
            if (result.length === 0) {
                con.query(`INSERT INTO Users (uid, language, premium) VALUES ('${callbackQuery.message.chat.id}', '${lang}', false)`, function (err, result, fields) {
                    if (err) throw err;
                    console.log(result)
                })
            } else {
                con.query(`UPDATE Users SET language='${lang}' WHERE (uid='${callbackQuery.message.chat.id}')`, function (err, result, fields) {
                    if (err) throw err;
                    console.log(result)
                })
            }
        })
    }
});

bot.on('photo', (p) => {
    bot.forwardMessage(process.env.ADMIN_TG_ID, p.chat.id, p.message_id).then(() => {
        bot.sendMessage(process.env.ADMIN_TG_ID, `Upper image sender is \n[uid ${p.chat.id} | name ${p.chat.first_name}]`)
    })
})

bot.on('document', (p) => {
    bot.sendMessage(p.chat.id, `Please send your attachment as a 'photo', not as a 'file'`)
})

bot.on('message', (user) => {
    console.log(`User ${user.chat.id} ${user.chat.first_name}, Message - ${user.text}, ${!!user.photo ? `Photo id ${user.photo[user.photo.length - 1].file_id}` : ''}`);
})

cron.schedule("* * * * *", function () {
    fs.readFile('shutdown', 'utf8', (err, data) => {
        if (err) {
            console.error(err);
            return;
        }
        if (data === 'SHUTDOWN') {
            bot.sendMessage(process.env.ADMIN_TG_ID, `Shutdown initiated`).then(() => {
                process.exit(1);
            });
        }
    });
});