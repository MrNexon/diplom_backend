const dgram = require('dgram');
const express = require("express");
const mysql = require('mysql');
const cors = require('cors');
const lodash = require('lodash');
const bodyParser = require('body-parser')

//Обработка необработанных ошибок
process.on('uncaughtException', function (err) {
    console.error(err);
});

process.on('unhandledRejection', function (err) {
    console.error(err);
});

//Создание подключения к базе данных
const db = mysql.createConnection({
    host: 'localhost',
    user: 'diplom',
    password: 'diplom123',
    database: 'diplom',
    port: 6033
});

db.connect((err) => {
    if(err) throw err;
    console.log('Connected to MySQL Server!');
});

//Создание подключения к МК
const client = dgram.createSocket('udp4');
client.on('message', function(msg,info) {
    const boxIndex = msg.readUint8();
    console.log(`Box disable: ${boxIndex}`);
    for (const wsClient of wsClients) {
        wsClient.send(JSON.stringify({
            disable: boxIndex
        }));
    }
});

//Создание подключения к фронтенду
const wsClients = [];
const WebSocketServer = require('ws');
const wss = new WebSocketServer.Server({ port: 3001 })
wss.on("connection", ws => {
    console.log("new client connected");
    ws.on("close", () => {
        console.log("the client has connected");
    });

    ws.onerror = function () {
        console.log("Some Error occurred")
    }
    wsClients.push(ws);
});
console.log("The WebSocket server is running on port 3001");

//Создание веб-сервера бэкенда
const app = express();
app.use(cors());
app.use(bodyParser.json());

//Метод получения вещей
app.get('/things', (req, res) => {
    //Отправляем запрос к БД на получение всех записей из таблицы things
    db.query('SELECT * FROM things', (err, rows) => {
        res.json(rows)
    })
});

//Админский метод для получения детальной информации о всех вещах и их деталях
app.get('/admin/things', (req, res) => {
    db.query(`
    SELECT
        things.id as thinkId,
        things.name as thinkName,
        d.id as detailId,
        d.name as detailName,
        td.quantity as detailQuantityNeed,
        d.quantity as detailQuantity
    FROM things
        LEFT JOIN things_details td on things.id = td.thing_id
        LEFT JOIN details d on d.id = td.detail_id
    `, (err, rows) => {
        const grouped = lodash.groupBy(rows, (row) => row.thinkName);
        const keys = Object.keys(grouped);
        const result = [];
        for (const key of keys) {
            const record = grouped[key];
            result.push({
                thing: {
                    id: record[0].thinkId,
                    name: record[0].thinkName
                },
                details: record.map((val) => {
                    return {
                        id: val.detailId,
                        name: val.detailName,
                        quantity: val.detailQuantity,
                        need: val.detailQuantityNeed
                    }
                })

            })
        }
        res.json(result)
    })
});


//Админский метод для удаления вещей
app.delete('/admin/thing/:thingId', (req, res) => {
    const id = req.params['thingId'];
    if (!id || isNaN(parseInt(id))) { res.sendStatus(400); return; }
    db.query(`DELETE FROM things WHERE id = ${id}`, (err, rows) => {
        res.json(rows)
    })
});

//Админский метод для удаления деталей
app.delete('/admin/detail/:detailId', (req, res) => {
    const id = req.params['detailId'];
    if (!id || isNaN(parseInt(id))) { res.sendStatus(400); return; }
    db.query(`DELETE FROM details WHERE id = ${id}`, (err, rows) => {
        res.json(rows)
    })
});

//Админский метод для сохранения переданных деталей
app.post('/admin/details', (req, res) => {
    if (!Array.isArray(req.body)) { res.sendStatus(400); return; }

    let sql = 'INSERT INTO details (name, box_index, quantity)';
    const values = [];

    for (const data of req.body) {
        if (!data.name || !data.box_index || !data.quantity) continue;
        values.push(`("${data.name}", ${data.box_index}, ${data.quantity})`);
    }
    try {
        db.query(`${sql} VALUES ${values.join(',')}`);
    } catch (e) {
        if (!Array.isArray(req.body)) { res.status(400).json(e); return; }
    }

    res.end();
});

//Админский метод для сохранения вещей и информации о деталях
app.post('/admin/thing', (req, res) => {
    if (!Array.isArray(req.body?.details)) { res.sendStatus(400); return; }

    let sql = `INSERT INTO things (name) VALUE ("${req.body.name}")`;
    db.query(sql, (err, rows) => {
        if (err) {res.status(400).json(err); return;}
        if (!rows.insertId) { res.status(400).json({error: 'No returned id'}); return; }

        const id = rows.insertId;

        let relationSql = 'INSERT INTO things_details (thing_id, detail_id, quantity)';
        const records = [];
        for (const detail of req.body.details) {
            if (isNaN(parseInt(detail.id))) continue;

            records.push(`(${id}, ${detail.id}, ${detail.need})`);
        }

        db.query(`${relationSql} VALUES ${records.join(',')}`, (err) => {
            if (err) {res.status(400).json(err); return;}
        })
    });
    res.end();
});

//Админский метод для получения всех деталей
app.get('/admin/details', (req, res) => {
    db.query('SELECT * FROM details', (err, rows) => {
        res.json(rows)
    })
});

//Метод для получения деталей для определенной вещи
app.get('/details/:thingId', (req, res) => {
    const id = req.params['thingId'];
    if (!id || isNaN(parseInt(id))) { res.sendStatus(400); return; }
    db.query(
        `SELECT d.id, d.name, d.box_index, things_details.quantity as need, d.quantity FROM things_details 
        LEFT JOIN details d on d.id = things_details.detail_id
        WHERE thing_id = ${id}`,
    (err, rows) => {
        res.json(rows)
    })
});

//Метод для отправки запроса на МК о сборке деталей
app.post('/details/:thingId/build', (req, res) => {
    //Проверка входных параметров
    const id = req.params['thingId'];
    if (!id || isNaN(parseInt(id))) { res.sendStatus(400); return; }
    //Запрос в базу данных на получения информации о вещи и деталях (в тч в каких коробках и сколько нужно)
    db.query(
        `SELECT d.id, d.quantity, things_details.quantity as need, d.box_index FROM things_details 
        LEFT JOIN details d on d.id = things_details.detail_id
        WHERE thing_id = ${id}`,
        (err, rows) => {
            const result = [];
            for (const row of rows) {
                //Проверка наличия всех деталей
                if (row.quantity < row.need) {
                    res.status(400);
                    res.json({ message: 'Not enough details' });
                    return;
                }

                result.push({
                    id: row.id,
                    quantity: row.quantity - row.need,
                    boxIndex: row.box_index,
                    need: row.need,
                })
            }

            //Сбор данных для МК
            const data = Buffer.from(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0]));
            for (const r of result) {
                db.query(
                    `UPDATE details SET quantity = ${r.quantity} WHERE id = ${r.id}`
                );
                data[r.boxIndex] = r.need;
            }

            //Отправка данных на МК об индексах коробок и количестве
            client.send(data, 9000, 'diplom.local', function(error){
                if (error) {
                    console.log(error)
                    client.close();
                } else{
                    console.log('Data sent');
                }
            });

            res.end();
        }
    );
})

//Запуск веб-сервера бэкенда
app.listen(3000, () => {
    console.log('Server is running at port 3000');
});
