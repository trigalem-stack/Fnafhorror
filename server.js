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

const DAY_NIGHT_DURATION = 6 * 60 * 1000; 
const MAP_SIZE = 100;
const MAX_DROPPED_LOGS = 30; // Ограничение для Render.com (чтобы не лагало)

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
                x: Number(tx.toFixed(2)),
                z: Number(tz.toFixed(2)),
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
                logCounter: 0, 
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
            // Убрано p.bagCount = data.bagCount! Это фиксит баг, где 3 бревна становились 1
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
                    if (lobby.world.droppedLogs.length > MAX_DROPPED_LOGS) {
                        lobby.world.droppedLogs.shift();
                    }
                    lobby.world.logCounter++;
                    lobby.world.droppedLogs.push({
                        id: 'log_' + lobby.world.logCounter,
                        x: tree.x + (Math.random() - 0.5) * 1.5,
                        y: 0.3,
                        z: tree.z + (Math.random() - 0.5) * 1.5,
                        collected: false
                    });
                }
            }
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
            lobby.world.droppedLogs[logIndex].collected = true; 
            p.bagCount += 1;
            socket.emit('bagSync', p.bagCount); // Сервер управляет инвентарем
        }
    });

    socket.on('dropLog', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        const p = lobby.players.find(pl => pl.id === socket.id);
        if (!p || p.bagCount <= 0) return;

        p.bagCount -= 1;
        socket.emit('bagSync', p.bagCount);

        let dist = 1.0; // Прямо перед игроком 
        let lx = p.x - Math.sin(p.ry) * dist;
        let lz = p.z - Math.cos(p.ry) * dist;
        
        if (lobby.world.droppedLogs.length > MAX_DROPPED_LOGS) lobby.world.droppedLogs.shift();
        
        lobby.world.logCounter++;
        // Бревно теперь появляется перед камерой (высоко) и падает СТРОГО вниз
        lobby.world.droppedLogs.push({
            id: 'log_' + lobby.world.logCounter,
            x: lx,
            y: 1.5, 
            z: lz,
            collected: false
        });
    });

    socket.on('kickPlayer', (playerId) => { 
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if (lobby.admin === socket.id) {
            const p = lobby.players.find(pl => pl.id === playerId);
            if (p) {
                io.to(p.id).emit('kicked');
                lobby.players = lobby.players.filter(pl => pl.id !== playerId);
                io.to(lobby.id).emit('lobbyUpdated', lobby);
            }
        }
    });

    socket.on('disbandLobby', () => { 
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if (lobby.admin === socket.id) {
            io.to(lobby.id).emit('lobbyDisbanded');
            delete lobbies[currentLobby];
            currentLobby = null;
            io.emit('updateLobbyList', getLobbiesList());
        }
    });

    socket.on('leaveLobby', () => { 
        handlePlayerLeave(socket);
    });
    
    socket.on('startGame', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if (lobby.admin === socket.id) {
            lobby.isPlaying = true;
            io.to(lobby.id).emit('gameStarted', lobby.world.trees);
            io.emit('updateLobbyList', getLobbiesList());
            startGameTicker(lobby.id);
        }
    });
    
    socket.on('disconnect', () => { 
        handlePlayerLeave(socket);
    });

    function handlePlayerLeave(socket) {
        if (currentLobby && lobbies[currentLobby]) {
            const lobby = lobbies[currentLobby];
            lobby.players = lobby.players.filter(p => p.id !== socket.id);
            if (lobby.players.length === 0) {
                delete lobbies[currentLobby]; 
            } else {
                io.to(lobby.id).emit('lobbyUpdated', lobby);
                if (lobby.admin === socket.id) lobby.admin = lobby.players[0].id;
            }
            currentLobby = null;
            io.emit('updateLobbyList', getLobbiesList());
        }
    }
});

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

        lobby.world.timeProgress += dt;
        lobby.world.isNight = lobby.world.timeProgress >= DAY_NIGHT_DURATION / 2;

        if (lobby.world.timeProgress >= DAY_NIGHT_DURATION) {
            lobby.world.timeProgress -= DAY_NIGHT_DURATION; 
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
        } else {
            lastCampfireTick = now; 
        }

        // Физика падения бревен: бревна падают строго вниз
        lobby.world.droppedLogs.forEach(log => {
            if (log.y > 0.2) {
                log.y -= 0.15; // Скорость падения вниз
            } else {
                log.y = 0.2;
            }

            if (!log.collected) {
                let dx = log.x - cf.x;
                let dz = log.z - cf.z;
                // Если бревно упало рядом с костром (радиус увеличен для удобства)
                if (Math.sqrt(dx*dx + dz*dz) < 1.8 && log.y < 0.8) {
                    log.collected = true; 
                    
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
                        if(cf.hp === 0) cf.hp = 1;
                    } else if (cf.hp > 100) {
                        cf.hp = 100; 
                    }
                }
            }
        });

        lobby.world.droppedLogs = lobby.world.droppedLogs.filter(l => !l.collected);

        // Отправка оптимизированных пакетов только с необходимыми данными
        io.to(lobbyId).emit('worldSync', {
            day: lobby.world.day,
            isNight: lobby.world.isNight,
            timeProgress: lobby.world.timeProgress,
            campfire: lobby.world.campfire,
            droppedLogs: lobby.world.droppedLogs.map(l => ({
                id: l.id, x: Number(l.x.toFixed(2)), y: Number(l.y.toFixed(2)), z: Number(l.z.toFixed(2))
            })) 
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
