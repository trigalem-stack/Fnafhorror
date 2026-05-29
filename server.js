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

// Цикл теперь 6 минут: ровно 3 минуты день, 3 минуты ночь.
const DAY_NIGHT_DURATION = 6 * 60 * 1000; 
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
        
        const trees = [];
        for (let i = 0; i < 60; i++) {
            let tx = (Math.random() - 0.5) * MAP_SIZE;
            let tz = (Math.random() - 0.5) * MAP_SIZE;
            if (Math.sqrt(tx*tx + tz*tz) < 8) {
                tx += 10;
                tz += 10;
            }
            trees.push({
                id: 'tree_' + i,
                x: tx,
                z: tz,
                hp: 4,
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
            world: {
                day: 1, 
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
        const colors = [0xff4444, 0x44ff44, 0x4444ff, 0xffff44, 0xff44ff, 0x44ffff, 0xffa500, 0xffffff];
        const randomColor = colors[lobby.players.length % colors.length];

        lobby.players.push({ 
            id: socket.id, 
            name: socket.nickname,
            x: (Math.random() - 0.5) * 4, 
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

    socket.on('hitTree', (treeId) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        const tree = lobby.world.trees.find(t => t.id === treeId && !t.isCut);
        if (tree) {
            tree.hp -= 1;
            io.to(lobby.id).emit('treeHit', treeId); 
            
            if (tree.hp <= 0) {
                tree.isCut = true;
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
            // Отправляем конкретно это обновленное дерево для оптимизации
            io.to(lobby.id).emit('treeUpdated', tree);
        }
    });

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
        }
    });

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
                let hpGain = 20; 
                if (cf.level === 2) hpGain = 18;
                if (cf.level === 3) hpGain = 15;
                if (cf.level === 4) hpGain = 12;
                if (cf.level === 5) hpGain = 10;
                if (cf.level >= 6) hpGain = 8;

                cf.hp += hpGain;
                
                if (cf.hp >= 100 && cf.level < 6) {
                    cf.level += 1;
                    cf.hp = cf.hp - 100; 
                } else if (cf.hp > 100 && cf.level >= 6) {
                    cf.hp = 100; 
                }
            }
        } else {
            let dist = 2;
            let lx = p.x - Math.sin(p.ry) * dist;
            let lz = p.z - Math.cos(p.ry) * dist;
            lobby.world.droppedLogs.push({
                id: 'log_' + Date.now() + '_' + Math.random(),
                x: lx,
                y: 1.5, 
                z: lz,
                vx: -Math.sin(p.ry) * 0.15,
                vz: -Math.cos(p.ry) * 0.15,
                collected: false
            });
        }
    });

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
            // Отправляем все деревья только 1 раз на старте
            io.to(lobby.id).emit('gameStarted', lobby.world.trees);
            io.emit('updateLobbyList', getLobbiesList());
            
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

function startGameTicker(lobbyId) {
    let lastCampfireTick = Date.now();
    let lastGlobalTick = Date.now();

    // ОПТИМИЗАЦИЯ СЕРВЕРА: снижено с 50мс до 100мс. Для такой игры 10fps тика сети хватает с головой
    const interval = setInterval(() => {
        const lobby = lobbies[lobbyId];
        if (!lobby || !lobby.isPlaying) {
            clearInterval(interval);
            return;
        }

        const now = Date.now();
        const dt = now - lastGlobalTick;
        lastGlobalTick = now;

        // Корректная логика дня и ночи
        lobby.world.timeProgress += dt;
        lobby.world.isNight = lobby.world.timeProgress >= DAY_NIGHT_DURATION / 2;

        if (lobby.world.timeProgress >= DAY_NIGHT_DURATION) {
            lobby.world.timeProgress -= DAY_NIGHT_DURATION; // Чтобы не терять миллисекунды
            lobby.world.day += 1; 
        }

        let cf = lobby.world.campfire;
        if (cf.hp > 0) {
            let tickRate = 1000; 
            if (cf.level === 2) tickRate = 1200;
            if (cf.level === 3) tickRate = 1500;
            if (cf.level === 4) tickRate = 1800;
            if (cf.level === 5) tickRate = 2200;
            if (cf.level >= 6) tickRate = 3000;

            if (now - lastCampfireTick >= tickRate) {
                cf.hp -= 1;
                if (cf.hp < 0) cf.hp = 0;
                lastCampfireTick = now;
            }
        }

        lobby.world.droppedLogs.forEach(log => {
            if (log.y > 0.2) {
                log.y -= 0.08; 
                log.x += log.vx;
                log.z += log.vz;
                log.vx *= 0.9;
                log.vz *= 0.9;
            } else {
                log.y = 0.2;
            }
        });

        // Отправляем урезанный WorldSync БЕЗ массива из 60 деревьев
        io.to(lobbyId).emit('worldSync', {
            day: lobby.world.day,
            isNight: lobby.world.isNight,
            timeProgress: lobby.world.timeProgress,
            campfire: lobby.world.campfire,
            droppedLogs: lobby.world.droppedLogs
        });
        io.to(lobbyId).emit('playersSync', lobby.players);

    }, 100);
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
