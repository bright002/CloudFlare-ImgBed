/**
 * D1 数据库操作工具类 (高性能优化版：消除 INSERT OR REPLACE 锁表 + 内置 Settings 内存缓存)
 */

// Worker 实例级内存缓存，大幅削减 settings 表的高频重复 SELECT
const settingsCache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 缓存有效期 60 秒

function getFromCache(key) {
    const item = settingsCache.get(key);
    if (!item) return undefined;
    if (Date.now() > item.expiry) {
        settingsCache.delete(key);
        return undefined;
    }
    return item.value;
}

function setToCache(key, value) {
    // 限制最大缓存条目数，防止内存无限增长
    if (settingsCache.size > 500) {
        const firstKey = settingsCache.keys().next().value;
        settingsCache.delete(firstKey);
    }
    settingsCache.set(key, {
        value: value,
        expiry: Date.now() + CACHE_TTL_MS
    });
}

class D1Database {
    constructor(db) {
        this.db = db;
    }
}

// ==================== 文件操作 ====================

/**
 * 保存文件记录 (替代 KV.put)
 * 优化：使用 ON CONFLICT(id) DO UPDATE 替代 INSERT OR REPLACE，避免隐式 DELETE 和重建全部索引
 */
D1Database.prototype.putFile = function(fileId, value, options) {
    value = value || '';
    options = options || {};
    var metadata = options.metadata || {};
    
    // 从metadata中提取字段用于索引
    var extractedFields = this.extractMetadataFields(metadata);
    
    var stmt = this.db.prepare(
        'INSERT INTO files (' +
        'id, value, metadata, file_name, file_type, file_size, ' +
        'upload_ip, upload_address, list_type, timestamp, ' +
        'label, directory, channel, channel_name, ' +
        'tg_file_id, tg_chat_id, tg_bot_token, is_chunked' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET ' +
        'value = excluded.value, ' +
        'metadata = excluded.metadata, ' +
        'file_name = excluded.file_name, ' +
        'file_type = excluded.file_type, ' +
        'file_size = excluded.file_size, ' +
        'list_type = excluded.list_type, ' +
        'timestamp = excluded.timestamp, ' +
        'label = excluded.label, ' +
        'directory = excluded.directory'
    );
    
    return stmt.bind(
        fileId,
        value,
        JSON.stringify(metadata),
        extractedFields.fileName,
        extractedFields.fileType,
        extractedFields.fileSize,
        extractedFields.uploadIP,
        extractedFields.uploadAddress,
        extractedFields.listType,
        extractedFields.timestamp,
        extractedFields.label,
        extractedFields.directory,
        extractedFields.channel,
        extractedFields.channelName,
        extractedFields.tgFileId,
        extractedFields.tgChatId,
        extractedFields.tgBotToken,
        extractedFields.isChunked
    ).run();
};

/**
 * 获取文件记录 (替代 KV.get)
 */
D1Database.prototype.getFile = function(fileId) {
    var stmt = this.db.prepare('SELECT value, metadata FROM files WHERE id = ?');
    return stmt.bind(fileId).first().then(function(result) {
        if (!result) return null;
        
        return {
            value: result.value,
            metadata: JSON.parse(result.metadata || '{}')
        };
    });
};

/**
 * 获取文件记录包含元数据 (替代 KV.getWithMetadata)
 */
D1Database.prototype.getFileWithMetadata = function(fileId) {
    return this.getFile(fileId);
};

/**
 * 删除文件记录 (替代 KV.delete)
 */
D1Database.prototype.deleteFile = function(fileId) {
    var stmt = this.db.prepare('DELETE FROM files WHERE id = ?');
    return stmt.bind(fileId).run();
};

/**
 * 列出文件 (替代 KV.list)
 */
D1Database.prototype.listFiles = function(options) {
    options = options || {};
    var prefix = options.prefix || '';
    var limit = Math.min(options.limit || 500, 1000);
    var cursor = options.cursor || null;
    
    var query = 'SELECT id, metadata FROM files';
    var params = [];
    
    if (prefix) {
        query += ' WHERE id LIKE ?';
        params.push(prefix + '%');
    }
    
    if (cursor) {
        query += prefix ? ' AND' : ' WHERE';
        query += ' id > ?';
        params.push(cursor);
    }
    
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);
    
    var stmt = this.db.prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        var results = response.results || [];
        var hasMore = results.length > limit;
        if (hasMore) {
            results.pop();
        }

        var keys = results.map(function(row) {
            return {
                name: row.id,
                metadata: JSON.parse(row.metadata || '{}')
            };
        });
        
        return {
            keys: keys,
            cursor: hasMore && keys.length > 0 ? keys[keys.length - 1].name : null,
            list_complete: !hasMore
        };
    });
};

// ==================== 设置操作 ====================

/**
 * 保存设置 (替代 KV.put)
 * 优化：使用 ON CONFLICT 原地更新并同步更新内存缓存
 */
D1Database.prototype.putSetting = function(key, value, category) {
    if (!category && key.startsWith('manage@sysConfig@')) {
        category = key.split('@')[2];
    }
    
    // 如果缓存中值完全一致，直接跳过数据库写入，节省 D1 写入配额！
    const cachedVal = getFromCache(key);
    if (cachedVal !== undefined && cachedVal === value) {
        return Promise.resolve({ success: true, cached: true });
    }

    setToCache(key, value);
    
    var stmt = this.db.prepare(
        'INSERT INTO settings (key, value, category) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, category = excluded.category'
    );
    
    return stmt.bind(key, value, category).run();
};

/**
 * 获取设置 (替代 KV.get)
 * 优化：优先命中内存缓存，避免每次 API 请求都查库
 */
D1Database.prototype.getSetting = function(key) {
    const cached = getFromCache(key);
    if (cached !== undefined) {
        return Promise.resolve(cached);
    }

    var stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    return stmt.bind(key).first().then(function(result) {
        const val = result ? result.value : null;
        if (val !== null) {
            setToCache(key, val);
        }
        return val;
    });
};

/**
 * 删除设置 (替代 KV.delete)
 */
D1Database.prototype.deleteSetting = function(key) {
    settingsCache.delete(key);
    var stmt = this.db.prepare('DELETE FROM settings WHERE key = ?');
    return stmt.bind(key).run();
};

/**
 * 列出设置 (替代 KV.list)
 */
D1Database.prototype.listSettings = function(options) {
    options = options || {};
    var prefix = options.prefix || '';
    var limit = options.limit || 1000;
    
    var query = 'SELECT key, value FROM settings';
    var params = [];
    
    if (prefix) {
        query += ' WHERE key LIKE ?';
        params.push(prefix + '%');
    }
    
    query += ' ORDER BY key LIMIT ?';
    params.push(limit);
    
    var stmt = this.db.prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        var results = response.results || [];
        var keys = results.map(function(row) {
            setToCache(row.key, row.value);
            return {
                name: row.key,
                value: row.value
            };
        });

        return { keys: keys };
    });
};

// ==================== 索引操作 ====================

/**
 * 保存索引操作记录
 */
D1Database.prototype.putIndexOperation = function(operationId, operation) {
    var stmt = this.db.prepare(
        'INSERT INTO index_operations (id, type, timestamp, data) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET type = excluded.type, timestamp = excluded.timestamp, data = excluded.data'
    );
    
    return stmt.bind(
        operationId,
        operation.type,
        operation.timestamp,
        JSON.stringify(operation.data)
    ).run();
};

/**
 * 获取索引操作记录
 */
D1Database.prototype.getIndexOperation = function(operationId) {
    var stmt = this.db.prepare('SELECT * FROM index_operations WHERE id = ?');
    return stmt.bind(operationId).first().then(function(result) {
        if (!result) return null;
        
        return {
            type: result.type,
            timestamp: result.timestamp,
            data: JSON.parse(result.data)
        };
    });
};

/**
 * 删除索引操作记录
 */
D1Database.prototype.deleteIndexOperation = function(operationId) {
    var stmt = this.db.prepare('DELETE FROM index_operations WHERE id = ?');
    return stmt.bind(operationId).run();
};

/**
 * 列出索引操作记录
 */
D1Database.prototype.listIndexOperations = function(options) {
    options = options || {};
    var limit = options.limit || 1000;
    var processed = options.processed;
    
    var query = 'SELECT * FROM index_operations';
    var params = [];
    
    if (processed !== null && processed !== undefined) {
        query += ' WHERE processed = ?';
        params.push(processed);
    }
    
    query += ' ORDER BY timestamp LIMIT ?';
    params.push(limit);
    
    var stmt = this.db.prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        var results = response.results || [];
        return results.map(function(row) {
            return {
                id: row.id,
                type: row.type,
                timestamp: row.timestamp,
                data: JSON.parse(row.data),
                processed: row.processed
            };
        });
    });
};

// ==================== 工具方法 ====================

/**
 * 从metadata中提取字段用于索引
 */
D1Database.prototype.extractMetadataFields = function(metadata) {
    return {
        fileName: metadata.FileName || null,
        fileType: metadata.FileType || null,
        fileSize: metadata.FileSize || null,
        uploadIP: metadata.UploadIP || null,
        uploadAddress: metadata.UploadAddress || null,
        listType: metadata.ListType || null,
        timestamp: metadata.TimeStamp || null,
        label: metadata.Label || null,
        directory: metadata.Directory || null,
        channel: metadata.Channel || null,
        channelName: metadata.ChannelName || null,
        tgFileId: metadata.TgFileId || null,
        tgChatId: null,
        tgBotToken: null,
        isChunked: metadata.IsChunked || false
    };
};

// ==================== 通用方法 ====================

/**
 * 通用的put方法，根据key类型自动选择存储位置
 */
D1Database.prototype.put = function(key, value, options) {
    options = options || {};

    if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        var operation = JSON.parse(value);
        return this.putIndexOperation(operationId, operation);
    } else if (key.startsWith('manage@')) {
        var category = key.split('@')[1] || '';
        return this.putSetting(key, value, category);
    } else {
        return this.putFile(key, value, options);
    }
};

/**
 * 通用的get方法，根据key类型自动选择获取位置
 */
D1Database.prototype.get = function(key) {
    if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        return this.getIndexOperation(operationId).then(function(operation) {
            return operation ? JSON.stringify(operation) : null;
        });
    } else if (key.startsWith('manage@')) {
        return this.getSetting(key);
    } else {
        return this.getFile(key).then(function(file) {
            return file ? file.value : null;
        });
    }
};

/**
 * 通用的getWithMetadata方法
 */
D1Database.prototype.getWithMetadata = function(key) {
    if (key.startsWith('manage@')) {
        return this.getSetting(key).then(function(value) {
            return value ? { value: value, metadata: {} } : null;
        });
    } else {
        return this.getFileWithMetadata(key);
    }
};

/**
 * 通用的delete方法
 */
D1Database.prototype.delete = function(key) {
    if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        return this.deleteIndexOperation(operationId);
    } else if (key.startsWith('manage@')) {
        return this.deleteSetting(key);
    } else {
        return this.deleteFile(key);
    }
};

/**
 * 通用的list方法
 */
D1Database.prototype.list = function(options) {
    options = options || {};
    var prefix = options.prefix || '';

    if (prefix.startsWith('manage@index@operation_')) {
        return this.listIndexOperations(options).then(function(operations) {
            var keys = operations.map(function(op) {
                return {
                    name: 'manage@index@operation_' + op.id
                };
            });
            return { keys: keys };
        });
    } else if (prefix.startsWith('manage@')) {
        return this.listSettings(options);
    } else {
        return this.listFiles(options);
    }
};

// 导出构造函数
export { D1Database };
