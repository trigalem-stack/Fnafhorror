const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

const lobbies = {};

// Глобальные настройки игры
const DAY_NIGHT_DURATION = 6 * 60 * 1000; // 6 минут (в миллисекундах)
const MAP_SIZE = 100;

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    let currentLobby = null;

    socket.on('setNickname', (nickname) => {
        socket.nickname = nickname;
        socket.emit('loginSuccess');
        socket.emit('updateLobbyList', getLobbiesList());
    });

    socket.on('createLobby', (data) => {
        const lobbyId = 'lobby_' + Date.now();
        
        // Генерация случайных деревьев для этого лобби
        const trees = [];
        for (let i = 0; i < 60; i++) {
            let tx = (Math.random() - 0.5) * MAP_SIZE;
            let tz = (Math.random() - 0.5) * MAP_SIZE;
            // Не спавнить деревья слишком близко к центру (где костер)
            if (Math.sqrt(tx*tx + tz*tz) < 8) {
                tx += 10;
                tz += 10;
            }
            trees.push({
                id: 'tree_' + i,
                x: tx,
                z: tz,
                hp: 4, // Ломается за 4 удара
                isCut: false,
                sinkY: 0
            });
        }

        lobbies[lobbyId] = {
            id: lobbyId,
            name: data.name,
            password: data.password,
            maxPlayers: data.maxPlayers,
            admin: socket.id,
            players: [],
            isPlaying: false,
            // Игровой мир
            world: {
                day: 0,
                isNight: false,
                timeProgress: 0,
                campfire: {
                    x: 0,
                    z: 0,
                    hp: 100,
                    level: 1,
                    maxHp: 100
                },
                trees: trees,
                droppedLogs: []
            }
        };
        
        socket.join(lobbyId);
        currentLobby = lobbyId;
        
        joinLobbyAction(socket, lobbies[lobbyId]);
    });

    socket.on('joinLobby', (data) => {
        const lobby = lobbies[data.id];
        if (!lobby) return socket.emit('errorMsg', 'Лобби не найдено');
        if (lobby.isPlaying) return socket.emit('errorMsg', 'Игра уже началась');
        if (lobby.players.length >= lobby.maxPlayers) return socket.emit('errorMsg', 'Лобби заполнено');
        if (lobby.password && lobby.password !== data.password) return socket.emit('errorMsg', 'Неверный пароль');

        socket.join(lobby.id);
        currentLobby = lobby.id;
        joinLobbyAction(socket, lobby);
    });

    function joinLobbyAction(socket, lobby) {
        // У каждого игрока свой случайный цвет
        const colors = [0xff4444, 0x44ff44, 0x4444ff, 0xffff44, 0xff44ff, 0x44ffff, 0xffa500, 0xffffff];
        const randomColor = colors[lobby.players.length % colors.length];

        lobby.players.push({ 
            id: socket.id, 
            name: socket.nickname,
            x: (Math.random() - 0.5) * 4, // Рядом с костром
            y: 1,
            z: (Math.random() - 0.5) * 4 + 4, 
            ry: 0,
            color: randomColor,
            bagCount: 0,
            activeSlot: 0
        });

        io.to(lobby.id).emit('lobbyUpdated', lobby);
        io.emit('updateLobbyList', getLobbiesList());
    }

    // Движение и апдейты от клиента во время игры
    socket.on('playerUpdate', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        const p = lobby.players.find(pl => pl.id === socket.id);
        if (p) {
            p.x = data.x;
            p.y = data.y;
            p.z = data.z;
            p.ry = data.ry;
            p.activeSlot = data.activeSlot;
            p.bagCount = data.bagCount;
        }
    });

    // Удар по дереву
    socket.on('hitTree', (treeId) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        const tree = lobby.world.trees.find(t => t.id === treeId && !t.isCut);
        if (tree) {
            tree.hp -= 1;
            if (tree.hp <= 0) {
                tree.isCut = true;
                // Спавним 3 бревна на этом месте
                for (let k = 0; k < 3; k++) {
                    lobby.world.droppedLogs.push({
                        id: 'log_' + Date.now() + '_' + Math.random(),
                        x: tree.x + (Math.random() - 0.5) * 1.5,
                        y: 0.3,
                        z: tree.z + (Math.random() - 0.5) * 1.5,
                        vx: (Math.random() - 0.5) * 0.1,
                        vz: (Math.random() - 0.5) * 0.1,
                        collected: false
                    });
                }
            }
            io.to(lobby.id).emit('worldSync', lobby.world);
        }
    });

    // Сбор бревна в мешок
    socket.on('collectLog', (logId) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        const p = lobby.players.find(pl => pl.id === socket.id);
        if (!p || p.bagCount >= 10) return;

        const logIndex = lobby.world.droppedLogs.findIndex(l => l.id === logId && !l.collected);
        if (logIndex !== -1) {
            lobby.world.droppedLogs.splice(logIndex, 1);
            p.bagCount += 1;
            socket.emit('bagSync', p.bagCount);
            io.to(lobby.id).emit('worldSync', lobby.world);
        }
    });

    // Выкинуть последнее бревно или отдать костру
    socket.on('dropLog', (actionTarget) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        const p = lobby.players.find(pl => pl.id === socket.id);
        if (!p || p.bagCount <= 0) return;

        p.bagCount -= 1;
        socket.emit('bagSync', p.bagCount);

        if (actionTarget === 'campfire') {
            let cf = lobby.world.campfire;
            if (cf.hp > 0) {
                // Если у костра минимум 81 хп, то добавление бревна прокачивает уровень
                if (cf.hp >= 81 && cf.level < 6) {
                    cf.level += 1;
                    cf.hp = 100;
                } else {
                    cf.hp = Math.min(100, cf.hp + 20);
                }
            }
        } else {
            // Обычный выброс на землю перед игроком с базовой физикой импульса
            let dist = 2;
            let lx = p.x - Math.sin(p.ry) * dist;
            let lz = p.z - Math.cos(p.ry) * dist;
            lobby.world.droppedLogs.push({
                id: 'log_' + Date.now() + '_' + Math.random(),
                x: lx,
                y: 1.5, // Падает сверху
                z: lz,
                vx: -Math.sin(p.ry) * 0.15,
                vz: -Math.cos(p.ry) * 0.15,
                collected: false
            });
        }
        io.to(lobby.id).emit('worldSync', lobby.world);
    });

    // --- КИКИ, СТАРТ И ВЫХОД ИЗ ЛОББИ ---
    socket.on('kickPlayer', (playerId) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if (lobby.admin === socket.id) {
            const playerSocket = io.sockets.sockets.get(playerId);
            if (playerSocket) {
                playerSocket.leave(lobby.id);
                playerSocket.emit('kicked');
            }
            lobby.players = lobby.players.filter(p => p.id !== playerId);
            io.to(lobby.id).emit('lobbyUpdated', lobby);
            io.emit('updateLobbyList', getLobbiesList());
        }
    });

    socket.on('disbandLobby', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if (lobby.admin === socket.id) {
            io.to(lobby.id).emit('lobbyDisbanded');
            lobby.players.forEach(p => {
                const pSocket = io.sockets.sockets.get(p.id);
                if (pSocket) pSocket.leave(lobby.id);
            });
            delete lobbies[currentLobby];
            currentLobby = null;
            io.emit('updateLobbyList', getLobbiesList());
        }
    });

    socket.on('leaveLobby', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        socket.leave(lobby.id);
        
        if (lobby.admin === socket.id) {
            io.to(lobby.id).emit('lobbyDisbanded');
            delete lobbies[currentLobby];
        } else {
            lobby.players = lobby.players.filter(p => p.id !== socket.id);
            io.to(lobby.id).emit('lobbyUpdated', lobby);
        }
        currentLobby = null;
        io.emit('updateLobbyList', getLobbiesList());
    });

    socket.on('startGame', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if (lobby.admin === socket.id) {
            lobby.isPlaying = true;
            io.to(lobby.id).emit('gameStarted');
            io.emit('updateLobbyList', getLobbiesList());
            
            // Запуск главного игрового тикера для этого лобби
            startGameTicker(lobby.id);
        }
    });

    socket.on('disconnect', () => {
        if (currentLobby && lobbies[currentLobby]) {
            const lobby = lobbies[currentLobby];
            if (lobby.admin === socket.id) {
                io.to(lobby.id).emit('lobbyDisbanded');
                delete lobbies[currentLobby];
            } else {
                lobby.players = lobby.players.filter(p => p.id !== socket.id);
                io.to(lobby.id).emit('lobbyUpdated', lobby);
            }
            io.emit('updateLobbyList', getLobbiesList());
        }
    });
});

// Игровой цикл на сервере (обновление костра, времени суток, физики логов)
function startGameTicker(lobbyId) {
    let lastCampfireTick = Date.now();
    let lastGlobalTick = Date.now();

    const interval = setInterval(() => {
        const lobby = lobbies[lobbyId];
        if (!lobby || !lobby.isPlaying) {
            clearInterval(interval);
            return;
        }

        const now = Date.now();
        const dt = now - lastGlobalTick;
        lastGlobalTick = now;

        // 1. Апдейт цикла времени (6 минут день, 6 минут ночь)
        lobby.world.timeProgress += dt;
        if (lobby.world.timeProgress >= DAY_NIGHT_DURATION) {
            lobby.world.timeProgress = 0;
            if (lobby.world.isNight) {
                lobby.world.isNight = false;
                lobby.world.day += 1; // Новое утро, увеличиваем счетчик дней
            } else {
                lobby.world.isNight = true;
            }
        }

        // 2. Убывание ХП костра в зависимости от его уровня
        let cf = lobby.world.campfire;
        if (cf.hp > 0) {
            let tickRate = 200; // по умолчанию 1 лвл (0.2с)
            if (cf.level === 2) tickRate = 350;
            if (cf.level === 3) tickRate = 500;
            if (cf.level === 4) tickRate = 650;
            if (cf.level === 5) tickRate = 800;
            if (cf.level >= 6) tickRate = 1000;

            if (now - lastCampfireTick >= tickRate) {
                cf.hp -= 1;
                if (cf.hp < 0) cf.hp = 0;
                lastCampfireTick = now;
            }
        }

        // 3. Симуляция базовой физики падения брёвен под землю или на траву
        lobby.world.droppedLogs.forEach(log => {
            if (log.y > 0.2) {
                log.y -= 0.08; // Гравитация
                log.x += log.vx;
                log.z += log.vz;
                log.vx *= 0.9;
                log.vz *= 0.9;
            } else {
                log.y = 0.2;
            }
        });

        // Плавное убирание срубленных деревьев под землю
        lobby.world.trees.forEach(t => {
            if (t.isCut && t.sinkY > -6) {
                t.sinkY -= 0.05;
            }
        });

        // Отправка данных всем игрокам в комнате
        io.to(lobbyId).emit('worldSync', lobby.world);
        io.to(lobbyId).emit('playersSync', lobby.players);

    }, 50);
}

function getLobbiesList() {
    return Object.values(lobbies).filter(l => !l.isPlaying).map(l => ({
        id: l.id,
        name: l.name,
        hasPassword: !!l.password,
        playersCount: l.players.length,
        maxPlayers: l.maxPlayers
    }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
