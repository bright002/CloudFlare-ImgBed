import {
    readIndex, mergeOperationsToIndex, deleteAllOperations, rebuildIndex,
    getIndexInfo, getIndexStorageStats
} from '../../utils/indexManager.js';
import { getDatabase } from '../../utils/databaseAdapter.js';
import { createMetadataViewContext, serializeFileRecordForManagement } from '../../utils/metadata/metadataView.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, waitUntil } = context;
    const url = new URL(request.url);

    // 解析查询参数（增加安全上限，防止单次 count 过大导致 503 CPU 超限）
    let start = parseInt(url.searchParams.get('start'), 10) || 0;
    let rawCount = parseInt(url.searchParams.get('count'), 10);
    let count = isNaN(rawCount) ? 50 : (rawCount === -1 ? -1 : Math.min(rawCount, 300));
    let sum = url.searchParams.get('sum') === 'true';
    let recursive = url.searchParams.get('recursive') === 'true';
    let dir = url.searchParams.get('dir') || '';
    let search = url.searchParams.get('search') || '';
    let channel = url.searchParams.get('channel') || '';
    let listType = url.searchParams.get('listType') || '';
    let accessStatus = url.searchParams.get('accessStatus') || '';
    let action = url.searchParams.get('action') || '';
    let includeTags = url.searchParams.get('includeTags') || '';
    let excludeTags = url.searchParams.get('excludeTags') || '';
    let label = url.searchParams.get('label') || '';
    let fileType = url.searchParams.get('fileType') || '';
    let channelName = url.searchParams.get('channelName') || '';

    if (search) {
        search = decodeURIComponent(search).trim();
    }

    const includeTagsArray = includeTags ? includeTags.split(',').map(t => t.trim()).filter(t => t) : [];
    const excludeTagsArray = excludeTags ? excludeTags.split(',').map(t => t.trim()).filter(t => t) : [];

    const listTypeArray = listType ? listType.split(',').map(t => t.trim()).filter(t => t) : [];
    const accessStatusArray = accessStatus ? accessStatus.split(',').map(t => t.trim()).filter(t => t) : [];
    const labelArray = label ? label.split(',').map(t => t.trim()).filter(t => t) : [];
    const fileTypeArray = fileType ? fileType.split(',').map(t => t.trim()).filter(t => t) : [];
    const channelArray = channel ? channel.split(',').map(t => t.trim()).filter(t => t) : [];
    const channelNameArray = channelName ? channelName.split(',').map(t => t.trim()).filter(t => t) : [];

    if (dir) {
        dir = dir.replace(/\.\./g, '_').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    }
    if (dir.startsWith('/')) {
        dir = dir.substring(1);
    }
    if (dir && !dir.endsWith('/')) {
        dir += '/';
    }

    try {
        // 特殊操作：重建索引
        if (action === 'rebuild') {
            waitUntil(rebuildIndex(context, (processed) => {
                console.log(`Rebuilt ${processed} files...`);
            }));

            return new Response('Index rebuilt asynchronously', {
                headers: { "Content-Type": "text/plain", ...corsHeaders }
            });
        }

        // 特殊操作：合并挂起的原子操作到索引
        if (action === 'merge-operations') {
            waitUntil(mergeOperationsToIndex(context));

            return new Response('Operations merged into index asynchronously', {
                headers: { "Content-Type": "text/plain", ...corsHeaders }
            });
        }

        // 特殊操作：清除所有原子操作
        if (action === 'delete-operations') {
            waitUntil(deleteAllOperations(context));

            return new Response('All operations deleted asynchronously', {
                headers: { "Content-Type": "text/plain", ...corsHeaders }
            });
        }

        // 特殊操作：获取索引存储信息
        if (action === 'index-storage-stats') {
            const stats = await getIndexStorageStats(context);
            return new Response(JSON.stringify(stats), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        // 特殊操作：获取索引信息
        if (action === 'info') {
            const info = await getIndexInfo(context, {
                timezoneOffset: url.searchParams.get('timezoneOffset'),
                maxPoints: url.searchParams.get('trendMaxPoints'),
                seriesLimit: url.searchParams.get('trendSeriesLimit'),
                startDate: url.searchParams.get('trendStartDate'),
                endDate: url.searchParams.get('trendEndDate')
            });
            return new Response(JSON.stringify(info), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        // 普通查询：只返回总数
        if (count === -1 && sum) {
            const result = await readIndex(context, {
                search,
                directory: dir,
                channel: channelArray,
                listType: listTypeArray,
                accessStatus: accessStatusArray,
                label: labelArray,
                fileType: fileTypeArray,
                channelName: channelNameArray,
                includeTags: includeTagsArray,
                excludeTags: excludeTagsArray,
                countOnly: true
            });

            return new Response(JSON.stringify({
                sum: result.totalCount,
                indexLastUpdated: result.indexLastUpdated
            }), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        // 普通查询：返回数据
        const result = await readIndex(context, {
            search,
            directory: dir,
            start,
            count,
            channel: channelArray,
            listType: listTypeArray,
            accessStatus: accessStatusArray,
            label: labelArray,
            fileType: fileTypeArray,
            channelName: channelNameArray,
            includeTags: includeTagsArray,
            excludeTags: excludeTagsArray,
            includeSubdirFiles: recursive,
        });

        // 索引读取失败时的安全降级：取消原有的 while(true) 全库扫描，限制只拉取单页
        if (!result.success) {
            const dbRecords = await getSafeFileRecords(context.env, dir, count);

            return new Response(JSON.stringify({
                files: dbRecords.files,
                directories: dbRecords.directories,
                totalCount: dbRecords.totalCount,
                directFileCount: dbRecords.directFileCount,
                directFolderCount: dbRecords.directFolderCount,
                returnedCount: dbRecords.returnedCount,
                indexLastUpdated: Date.now(),
                isIndexedResponse: false
            }), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        const db = getDatabase(context.env);
        const metadataViewContext = await createMetadataViewContext(db, context.env);

        // 转换文件格式
        const compatibleFiles = await Promise.all(
            result.files.map(file => serializeFileRecordForManagement(db, context.env, file, metadataViewContext))
        );

        return new Response(JSON.stringify({
            files: compatibleFiles,
            directories: result.directories,
            totalCount: result.totalCount,
            directFileCount: result.directFileCount,
            directFolderCount: result.directFolderCount,
            returnedCount: result.returnedCount,
            indexLastUpdated: result.indexLastUpdated,
            isIndexedResponse: true
        }), {
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "private, max-age=5",
                ...corsHeaders
            }
        });

    } catch (error) {
        console.error('Error in list-indexed API:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            message: error.message
        }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
        });
    }
}

/**
 * 安全降级查询：严禁 while(true) 拉取上万条记录，只查单批数据防止 503 崩溃
 */
async function getSafeFileRecords(env, dir, limitCount = 200) {
    const allRecords = [];

    try {
        const db = getDatabase(env);
        const metadataViewContext = await createMetadataViewContext(db, env);

        const response = await db.list({
            prefix: dir,
            limit: Math.min(Math.max(limitCount, 100), 400)
        });

        if (response && response.keys && Array.isArray(response.keys)) {
            for (const item of response.keys) {
                if (item.name.startsWith('manage@') || item.name.startsWith('chunk_')) {
                    continue;
                }
                if (!item.metadata || !item.metadata.TimeStamp) {
                    continue;
                }
                allRecords.push(await serializeFileRecordForManagement(db, env, item, metadataViewContext));
            }
        }

        const directories = new Set();
        const filteredRecords = [];
        allRecords.forEach(item => {
            const subDir = item.name.substring(dir.length);
            const firstSlashIndex = subDir.indexOf('/');
            if (firstSlashIndex !== -1) {
                directories.add(dir + subDir.substring(0, firstSlashIndex));
            } else {
                filteredRecords.push(item);
            }
        });

        return {
            files: filteredRecords,
            directories: Array.from(directories),
            totalCount: allRecords.length,
            directFileCount: filteredRecords.length,
            directFolderCount: directories.size,
            returnedCount: filteredRecords.length
        };

    } catch (error) {
        console.error('Error in getSafeFileRecords:', error);
        return {
            files: [],
            directories: [],
            totalCount: 0,
            directFileCount: 0,
            directFolderCount: 0,
            returnedCount: 0,
            error: error.message
        };
    }
}
