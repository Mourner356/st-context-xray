// Context X-Ray v0.3.1 - Termux 兼容版
(function() {
    'use strict';
    
    const VERSION = '0.3.1-termux';
    console.log(`[Context X-Ray ${VERSION}] 开始加载`);
    
    // 简单的悬浮球
    function createBall() {
        const ball = document.createElement('div');
        ball.id = 'cx_ball';
        ball.style.cssText = `
            position: fixed;
            right: 20px;
            bottom: 100px;
            width: 50px;
            height: 50px;
            background: rgba(30,30,34,0.9);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            cursor: pointer;
            z-index: 9999;
            user-select: none;
        `;
        ball.textContent = '🌸';
        ball.title = 'Context X-Ray';
        
        ball.addEventListener('click', function() {
            alert('Context X-Ray 简化版已加载！\\n\\n如看到此消息说明扩展运行正常，\\n但可能与 Termux 环境有兼容性问题。');
        });
        
        document.body.appendChild(ball);
        console.log(`[Context X-Ray ${VERSION}] 悬浮球已创建`);
    }
    
    // 等页面加载完成
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createBall);
    } else {
        createBall();
    }
    
    console.log(`[Context X-Ray ${VERSION}] 加载完成`);
})();
